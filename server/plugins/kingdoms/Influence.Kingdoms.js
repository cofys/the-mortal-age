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
 * Decay: raw points fall by INFLUENCE_DECAY_PER_DAY per idle day (linear,
 * floored at zero), settled lazily on read and on earn. Tenure bonus does
 * not decay — long service is remembered even when the coffers are quiet.
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

/** Raw points after settling idle decay, never negative. Decay accrues per whole idle day. */
function decayedPoints(rec, now) {
  const idleDays = Math.floor(Math.max(0, (now - (rec.lastEarned ?? now)) / DAY_MS));
  return Math.max(0, (rec.points ?? 0) - idleDays * INFLUENCE_DECAY_PER_DAY);
}

/** Tenure bonus: +1 per day since first service, capped. Never decays. */
function tenureBonus(rec, now) {
  const memberDays = Math.max(0, (now - (rec.firstEarned ?? now)) / DAY_MS);
  return Math.min(TENURE_BONUS_CAP, Math.floor(memberDays * TENURE_BONUS_PER_DAY));
}

/**
 * Effective influence: what the court weighs. Decayed points plus the
 * tenure bonus, floored at zero.
 */
function effectiveInfluence(player, kingdomId) {
  const rec = recordFor(player, kingdomId);
  if (!rec) return 0;
  const now = Date.now();
  return Math.floor(decayedPoints(rec, now)) + tenureBonus(rec, now);
}

/**
 * Add influence, settling decay first so idleness is honestly priced.
 * Returns the new raw point total.
 */
function addInfluence(player, kingdomId, amount) {
  if (!player?.setAttribute || !kingdomId || !(amount > 0)) return 0;
  const now = Date.now();
  const records = { ...recordsOf(player) };
  const rec = records[kingdomId] ?? blankRecord(now);
  rec.points = decayedPoints(rec, now) + amount;
  rec.lastEarned = now;
  records[kingdomId] = rec;
  player.setAttribute(INFLUENCE_ATTRIBUTE, records);
  return rec.points;
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
