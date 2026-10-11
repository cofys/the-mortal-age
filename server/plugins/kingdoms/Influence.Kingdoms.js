"use strict";

/**
 * Influence.Kingdoms — political capital: how much a kingdom values a player.
 *
 * Influence is earned by serving the realm and decays with idleness, so an
 * office is an achievement that must be maintained, not a prize kept forever
 * by an inactive holder.
 *
 * Sources (all flow through kingdom:* events; see Events.Kingdoms.js):
 *   kingdom:rank-granted    fealty (+10) or promotion (+25)
 *   kingdom:donation-made   war-effort donations, 1 influence per 100 coins
 *   kingdom:task-completed  kingdom tasks, +25 (hook for future task systems)
 *   tenure                  +1 per day of membership, capped at +30
 *
 * Hatred: influence can go negative (to HATRED_FLOOR). Negative influence is
 * earned through addInfluence with a reason ("oathbreaking", "assault",
 * "theft", "war-treason") and carries consequence tiers (see hatredTier):
 * disliked (< 0), hated (<= -25), enemy (<= -100). Negative influence decays
 * toward zero slowly (HATRED_DECAY_PER_DAY); positive service while negative
 * earns at half rate — redemption is harder than the fall.
 *
 * Decay: raw points fall by INFLUENCE_DECAY_PER_DAY per idle day (linear),
 * settled lazily on read and on earn. Positive decay floors at zero —
 * idleness never makes you hated. Negative decay rises toward zero.
 * Tenure bonus does not decay — long service is remembered even when the
 * coffers are quiet, and it softens hatred (the court remembers).
 *
 * Storage: one persisted player attribute, kingdom:influence, shaped
 *   { [kingdomId]: { points, firstEarned, lastEarned } }
 * Trials of service (see Politics.Kingdoms.js) live in kingdom:trial;
 * challenge cooldowns live in kingdom:challenge-cooldown.
 *
 * Pure module except for the attach function that persists the attributes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const Membership = require("./Membership.Kingdoms");

const INFLUENCE_ATTRIBUTE = "kingdom:influence";
const TRIAL_ATTRIBUTE = "kingdom:trial";
const CHALLENGE_COOLDOWN_ATTRIBUTE = "kingdom:challenge-cooldown";

const INFLUENCE_PER_FEALTY = 10;
const INFLUENCE_PER_PROMOTION = 25;
const INFLUENCE_PER_TASK = 25;
const INFLUENCE_PER_COIN = 1 / 100;
const TENURE_BONUS_PER_DAY = 1;
const TENURE_BONUS_CAP = 30;
const INFLUENCE_DECAY_PER_DAY = 2;

/** Hatred floor: influence can sink this low, no further. */
const HATRED_FLOOR = -150;
/** Negative influence decays toward zero this much per idle day (slower than positive decay). */
const HATRED_DECAY_PER_DAY = 1;
/** While negative, positive service earns at this rate — redemption is harder than the fall. */
const HATRED_EARN_RATE = 0.5;

/** Hatred tier thresholds, checked against effective influence. */
const HATRED_HATED_AT = -25;
const HATRED_ENEMY_AT = -100;

/** Oathbreaking: the influence hit taken with the abandoned kingdom. */
const OATHBREAK_HIT = -75;
/** Word spreads: per-other-kingdom chance of also losing influence. */
const OATHBREAK_SPREAD_CHANCE = 0.4;
/** Word spreads: the influence hit each hearing kingdom takes. */
const OATHBREAK_SPREAD_HIT = -15;

/** Reasons that earn negative influence. */
const NEGATIVE_REASONS = Object.freeze(["oathbreaking", "assault", "theft", "war-treason"]);

/** Influence needed to petition for a vacant office. */
const PETITION_THRESHOLD = 100;
/** Influence needed to challenge a held office. */
const CHALLENGE_THRESHOLD = 250;
/** Cooldown after losing (or declining) a challenge, per office. */
const CHALLENGE_COOLDOWN_MS = 7 * DAY_MS;

/**
 * Earned rank ladder. A player's home-kingdom choice becomes a progression
 * path: service (donations, tasks, fealty) earns influence, and crossing a
 * threshold promotes through the kingdom's hierarchy — no owner command
 * needed. Thresholds are effective influence (decayed points + tenure bonus).
 * Man-at-arms at 100 matches the petition threshold: the court notices you
 * exactly when you become eligible to petition for an office. Monarch is
 * NEVER earned — the great rulers' fates are questline content.
 */
const RANK_EARN_THRESHOLDS = Object.freeze([
  { rank: "Man-at-arms", at: 100 },
  { rank: "Knight", at: 300 },
  { rank: "Lord", at: 800 },
  { rank: "Regent", at: 2000 },
]);
const BASE_RANK = "Subject";

function blankRecord(now) {
  return { points: 0, firstEarned: now, lastEarned: now };
}

function recordsOf(player) {
  try {
    return player?.getAttribute?.(INFLUENCE_ATTRIBUTE) ?? {};
  } catch {
    return {};
  }
}

function recordFor(player, kingdomId) {
  const records = recordsOf(player);
  const rec = records[kingdomId];
  return rec && typeof rec === "object" ? rec : null;
}

/**
 * Raw points after settling idle decay. Positive points decay toward zero
 * (idleness never makes you hated); negative points rise toward zero slowly.
 * Floored at HATRED_FLOOR. Decay accrues per whole idle day.
 */
function decayedPoints(rec, now) {
  const idleDays = Math.floor(Math.max(0, (now - (rec.lastEarned ?? now)) / DAY_MS));
  const points = rec.points ?? 0;
  if (points > 0) {
    return Math.max(0, points - idleDays * INFLUENCE_DECAY_PER_DAY);
  }
  if (points < 0) {
    return Math.min(0, points + idleDays * HATRED_DECAY_PER_DAY);
  }
  return 0;
}

/** Tenure bonus: +1 per day since first service, capped. Never decays. */
function tenureBonus(rec, now) {
  const memberDays = Math.max(0, (now - (rec.firstEarned ?? now)) / DAY_MS);
  return Math.min(TENURE_BONUS_CAP, Math.floor(memberDays * TENURE_BONUS_PER_DAY));
}

/**
 * Effective influence: what the court weighs. Decayed points plus the
 * tenure bonus. Can go negative — the court remembers both service and
 * betrayal, and long service softens hatred.
 */
function effectiveInfluence(player, kingdomId) {
  const rec = recordFor(player, kingdomId);
  if (!rec) return 0;
  const now = Date.now();
  return Math.floor(decayedPoints(rec, now)) + tenureBonus(rec, now);
}

/**
 * Hatred tier for an effective influence value: "disliked" (< 0),
 * "hated" (<= -25), "enemy" (<= -100), or null when neutral-or-better.
 * Pure — pass effectiveInfluence(player, kingdomId).
 */
function hatredTier(effective) {
  if (!(effective < 0)) return null;
  if (effective <= HATRED_ENEMY_AT) return "enemy";
  if (effective <= HATRED_HATED_AT) return "hated";
  return "disliked";
}

/**
 * Add influence, settling decay first so idleness is honestly priced.
 * Amount may be negative (hatred): floored at HATRED_FLOOR. Positive
 * service while negative earns at HATRED_EARN_RATE. Reason is recorded
 * on the record when negative ("oathbreaking", "assault", "theft",
 * "war-treason"). Returns the new raw point total.
 */
function addInfluence(player, kingdomId, amount, reason) {
  if (!player?.setAttribute || !kingdomId) return 0;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0) return 0;
  const now = Date.now();
  const records = { ...recordsOf(player) };
  const rec = records[kingdomId] ?? blankRecord(now);
  const settled = decayedPoints(rec, now);
  let delta = amount;
  if (settled < 0 && amount > 0) {
    delta = amount * HATRED_EARN_RATE;
  }
  rec.points = Math.max(HATRED_FLOOR, settled + delta);
  rec.lastEarned = now;
  if (amount < 0 && typeof reason === "string" && reason.length > 0) {
    rec.lastReason = reason;
  }
  records[kingdomId] = rec;
  player.setAttribute(INFLUENCE_ATTRIBUTE, records);
  return rec.points;
}

/**
 * Break an oath to a kingdom: the oathbreaker takes OATHBREAK_HIT with the
 * abandoned kingdom, and word spreads — each other kingdom has
 * OATHBREAK_SPREAD_CHANCE to also take OATHBREAK_SPREAD_HIT ("other
 * kingdoms hear about your oathbreaking"). otherKingdomIds is injected so
 * this stays pure and testable (pass KingdomStore.getKingdoms() ids minus
 * the old one). rng is injectable for tests; defaults to Math.random.
 * Returns { oldKingdomId, oldPoints, spreadTo } or null on bad args.
 */
function breakOath(player, oldKingdomId, otherKingdomIds, rng) {
  if (!player?.setAttribute || !oldKingdomId) return null;
  const roll = typeof rng === "function" ? rng : Math.random;
  const oldPoints = addInfluence(player, oldKingdomId, OATHBREAK_HIT, "oathbreaking");
  const spreadTo = [];
  for (const kid of Array.isArray(otherKingdomIds) ? otherKingdomIds : []) {
    if (kid === oldKingdomId) continue;
    if (roll() < OATHBREAK_SPREAD_CHANCE) {
      addInfluence(player, kid, OATHBREAK_SPREAD_HIT, "oathbreaking");
      spreadTo.push(kid);
    }
  }
  return { oldKingdomId, oldPoints, spreadTo };
}

/**
 * Spend influence (e.g. on diplomacy actions). Settles idle decay first so
 * idleness is honestly priced, then deducts from raw points — the tenure
 * bonus is remembered service, not a spendable purse.
 * @returns {{ok: boolean, remaining?: number, reason?: string}}
 */
function spendInfluence(player, kingdomId, amount) {
  if (!player?.setAttribute || !kingdomId || !(amount > 0)) {
    return { ok: false, reason: "bad-args" };
  }
  const now = Date.now();
  const records = { ...recordsOf(player) };
  const rec = records[kingdomId];
  if (!rec || typeof rec !== "object") return { ok: false, reason: "no-record" };
  const settled = decayedPoints(rec, now);
  if (settled < amount) return { ok: false, reason: "insufficient", remaining: Math.floor(settled) };
  rec.points = settled - amount;
  rec.lastEarned = now;
  records[kingdomId] = rec;
  player.setAttribute(INFLUENCE_ATTRIBUTE, records);
  return { ok: true, remaining: Math.floor(rec.points) };
}

/** kingdom:rank-granted handler: fealty for the base rank, promotion otherwise. */
function onRankGranted(event) {
  const player = event?.player;
  const kingdomId = event?.kingdomId;
  if (!player?.setAttribute || !kingdomId || event?.quiet) return;
  const rank = event?.rank ?? "Subject";
  addInfluence(player, kingdomId, rank === "Subject" ? INFLUENCE_PER_FEALTY : INFLUENCE_PER_PROMOTION);
}

/** kingdom:task-completed handler. */
function onTaskCompleted(event) {
  const player = event?.player;
  const kingdomId = event?.kingdomId;
  if (!player?.setAttribute || !kingdomId) return;
  addInfluence(player, kingdomId, INFLUENCE_PER_TASK);
}

/** Rank the court owes a player at this effective influence. Never Monarch. */
function rankForInfluence(effective) {
  let rank = BASE_RANK;
  for (const t of RANK_EARN_THRESHOLDS) {
    if (effective >= t.at) rank = t.rank;
  }
  return rank;
}

/**
 * The rank a player has earned but does not yet hold, or null.
 * Guards: bots are excluded (the citizens director owns their promotions),
 * only the kingdom the player serves promotes them, ranks are never taken
 * away (influence decays; honors don't), and the target must sit in the
 * kingdom's own hierarchy below Monarch.
 */
function promotionTarget(player, kingdomId, hierarchy) {
  if (!player?.setAttribute || !kingdomId) return null;
  if (player.isPlayerBot?.() === true) return null;
  if ((player.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) ?? null) !== kingdomId) return null;
  const ladder = Array.isArray(hierarchy) ? hierarchy : [];
  const target = rankForInfluence(effectiveInfluence(player, kingdomId));
  const targetIdx = ladder.indexOf(target);
  if (targetIdx < 0) return null;
  const current = player.getAttribute?.(Membership.KINGDOM_RANK_ATTRIBUTE) ?? BASE_RANK;
  const currentIdx = ladder.indexOf(current);
  if (currentIdx < 0 || targetIdx <= currentIdx) return null;
  return target;
}

/**
 * Promote a player who has earned it. Emits kingdom:rank-granted through
 * the injected emitEvent (the Events module wires the real bus), so this
 * stays pure and testable. Returns the granted rank, or null when nothing
 * was earned. One hop: a player whose service skips ranks is named the
 * highest earned rank directly.
 */
function settlePromotion(player, kingdomId, hierarchy, emitEvent) {
  const target = promotionTarget(player, kingdomId, hierarchy);
  if (!target || typeof emitEvent !== "function") return null;
  emitEvent({ player, kingdomId, rank: target, via: "service" });
  return target;
}

/** Active trial of service, or null. */
function getTrial(player) {
  try {
    const trial = player?.getAttribute?.(TRIAL_ATTRIBUTE) ?? null;
    return trial && typeof trial === "object" ? trial : null;
  } catch {
    return null;
  }
}

function setTrial(player, trial) {
  if (!player?.setAttribute) return;
  player.setAttribute(TRIAL_ATTRIBUTE, trial);
}

function clearTrial(player) {
  if (!player?.setAttribute) return;
  player.setAttribute(TRIAL_ATTRIBUTE, null);
}

/** Milliseconds until the player may challenge this office again, or 0. */
function challengeCooldownRemainingMs(player, officeId) {
  let cooldowns = {};
  try {
    cooldowns = player?.getAttribute?.(CHALLENGE_COOLDOWN_ATTRIBUTE) ?? {};
  } catch {
    return 0;
  }
  const until = cooldowns[officeId];
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

/** Start the post-loss cooldown clock for one office. */
function setChallengeCooldown(player, officeId) {
  if (!player?.setAttribute || !officeId) return;
  let cooldowns = {};
  try {
    cooldowns = player.getAttribute(CHALLENGE_COOLDOWN_ATTRIBUTE) ?? {};
  } catch {
    cooldowns = {};
  }
  player.setAttribute(CHALLENGE_COOLDOWN_ATTRIBUTE, {
    ...cooldowns,
    [officeId]: Date.now() + CHALLENGE_COOLDOWN_MS,
  });
}

function attachInfluence(api) {
  api.persistAttribute(INFLUENCE_ATTRIBUTE);
  api.persistAttribute(TRIAL_ATTRIBUTE);
  api.persistAttribute(CHALLENGE_COOLDOWN_ATTRIBUTE);
}

module.exports = attachInfluence;
module.exports.INFLUENCE_ATTRIBUTE = INFLUENCE_ATTRIBUTE;
module.exports.TRIAL_ATTRIBUTE = TRIAL_ATTRIBUTE;
module.exports.CHALLENGE_COOLDOWN_ATTRIBUTE = CHALLENGE_COOLDOWN_ATTRIBUTE;
module.exports.INFLUENCE_PER_FEALTY = INFLUENCE_PER_FEALTY;
module.exports.INFLUENCE_PER_PROMOTION = INFLUENCE_PER_PROMOTION;
module.exports.INFLUENCE_PER_TASK = INFLUENCE_PER_TASK;
module.exports.INFLUENCE_PER_COIN = INFLUENCE_PER_COIN;
module.exports.INFLUENCE_DECAY_PER_DAY = INFLUENCE_DECAY_PER_DAY;
module.exports.HATRED_FLOOR = HATRED_FLOOR;
module.exports.HATRED_DECAY_PER_DAY = HATRED_DECAY_PER_DAY;
module.exports.HATRED_EARN_RATE = HATRED_EARN_RATE;
module.exports.HATRED_HATED_AT = HATRED_HATED_AT;
module.exports.HATRED_ENEMY_AT = HATRED_ENEMY_AT;
module.exports.OATHBREAK_HIT = OATHBREAK_HIT;
module.exports.OATHBREAK_SPREAD_CHANCE = OATHBREAK_SPREAD_CHANCE;
module.exports.OATHBREAK_SPREAD_HIT = OATHBREAK_SPREAD_HIT;
module.exports.NEGATIVE_REASONS = NEGATIVE_REASONS;
module.exports.hatredTier = hatredTier;
module.exports.breakOath = breakOath;
module.exports.PETITION_THRESHOLD = PETITION_THRESHOLD;
module.exports.CHALLENGE_THRESHOLD = CHALLENGE_THRESHOLD;
module.exports.CHALLENGE_COOLDOWN_MS = CHALLENGE_COOLDOWN_MS;
module.exports.RANK_EARN_THRESHOLDS = RANK_EARN_THRESHOLDS;
module.exports.BASE_RANK = BASE_RANK;
module.exports.rankForInfluence = rankForInfluence;
module.exports.promotionTarget = promotionTarget;
module.exports.settlePromotion = settlePromotion;
module.exports.effectiveInfluence = effectiveInfluence;
module.exports.addInfluence = addInfluence;
module.exports.spendInfluence = spendInfluence;
module.exports.onRankGranted = onRankGranted;
module.exports.onTaskCompleted = onTaskCompleted;
module.exports.getTrial = getTrial;
module.exports.setTrial = setTrial;
module.exports.clearTrial = clearTrial;
module.exports.challengeCooldownRemainingMs = challengeCooldownRemainingMs;
module.exports.setChallengeCooldown = setChallengeCooldown;
