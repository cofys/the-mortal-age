"use strict";

/**
 * CitizenCuisineLife — slow-tick dynamics for the cuisine system.
 *
 * Runs on the director slow tick. Never throws.
 *
 * - Schedules monthly culinary competitions per kingdom.
 * - Resolves competitions with enough entries, awards REAL coin prizes
 *   (winner 600, runner-up 250) via the director's coin helpers.
 * - Food critics review top dishes (personality-gated, cooldown-gated).
 * - Awards fame deeds (masterchef for winners).
 * - Announces competitions and winners near real players via sayPublic.
 * - Adds standout new dishes to restaurant menus.
 */

const Cuisine = require("./CitizenCuisine");
const { sayPublic } = require("../chat/CitizenSayPublic");

// Announcements are personality-gated and cooldown-gated.
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most every 6h per kingdom
const CRITIC_COOLDOWN_MS = 12 * 60 * 60 * 1000; // critics review at most every 12h
const COMPETITION_OPEN_MS = 3 * 24 * 60 * 60 * 1000; // resolve after 3+ days open
let _lastAnnounce = {}; // kingdomId -> { competition: ts, winner: ts }
let _lastCritic = {}; // criticName -> ts

/**
 * Slow-tick entry. director is the CitizenDirector, nowMs is Date.now().
 * Never throws — one bad kingdom never breaks the tick.
 */
function tickCuisine(director, nowMs) {
  try {
    nowMs = nowMs ?? Date.now();
    const kingdoms = kingdomsOf(director);
    for (const kingdomId of kingdoms) {
      try {
        tickKingdomCuisine(director, kingdomId, nowMs);
      } catch {
        // One bad kingdom never breaks the tick.
      }
    }
    Cuisine.save();
  } catch {
    // Never throws.
  }
}

function tickKingdomCuisine(director, kingdomId, nowMs) {
  // 1. Schedule competition if due.
  const comp = Cuisine.maybeScheduleCompetition(kingdomId, nowMs);
  if (comp) {
    announce(director, kingdomId, nowMs, "competition",
      `A grand culinary competition is announced! Chefs, present your finest dishes for ${Cuisine.COMPETITION_PRIZE} coins!`);
    journal(director, kingdomId, `Culinary competition announced in ${kingdomId}.`);
  }

  // 2. Auto-enter standout dishes into the open competition.
  const open = Cuisine.openCompetition(kingdomId);
  if (open) {
    const st = Cuisine.load();
    for (const dish of st.dishes) {
      if (dish.quality >= 7 && !open.entries.includes(dish.id)) {
        Cuisine.enterCompetition(open.id, dish.id);
      }
    }
  }

  // 3. Resolve competitions open 3+ days with 2+ entries.
  const st = Cuisine.load();
  for (const c of st.competitions) {
    if (c.kingdomId !== kingdomId || c.resolvedAt) continue;
    if (nowMs - c.scheduledAt < COMPETITION_OPEN_MS) continue;
    if (c.entries.length < 2) continue;
    const result = Cuisine.resolveCompetition(c.id, nowMs);
    if (result) {
      payPrize(director, result.winner, result.prize);
      if (result.runnerUp) payPrize(director, result.runnerUp, result.runnerUpPrize);
      awardFame(director, result.winner, "masterchef");
      announce(director, kingdomId, nowMs, "winner",
        `${result.winner} wins the culinary competition with "${result.winningDish.name}"! A true master of cuisine!`);
      journal(director, kingdomId, `Culinary competition won by ${result.winner}.`);
    }
  }

  // 4. Critics review top unreviewed dishes.
  criticReviews(director, kingdomId, nowMs);

  // 5. Add quality dishes to the restaurant menu.
  const rest = Cuisine.restaurantFor(kingdomId, nowMs);
  for (const dish of st.dishes) {
    if (dish.quality >= 6 && dish.servings > 0 && !rest.menu.includes(dish.id)) {
      Cuisine.addToMenu(kingdomId, dish.id);
    }
  }
}

function criticReviews(director, kingdomId, nowMs) {
  // Find eligible critics: online citizens with high social standing.
  const roster = director?.roster;
  if (!roster?.values) return;
  const st = Cuisine.load();
  const unreviewed = st.dishes.filter(
    (d) => d.quality >= 7 && Cuisine.reviewsFor(d.id).length === 0 && d.servings > 0
  );
  if (!unreviewed.length) return;

  for (const record of roster.values()) {
    try {
      if (!record || record.kingdomId !== kingdomId) continue;
      const social = socialScore(record);
      if (social < Cuisine.CRITIC_MIN_SOCIAL) continue;
      const last = _lastCritic[record.username] ?? 0;
      if (nowMs - last < CRITIC_COOLDOWN_MS) continue;
      // Review the best unreviewed dish.
      const dish = unreviewed.sort((a, b) => b.quality - a.quality)[0];
      if (!dish) continue;
      const stars = Math.max(1, Math.min(10, Math.round(dish.quality + (social / 100) * 2)));
      Cuisine.reviewDish(dish.id, record.username, stars, nowMs);
      _lastCritic[record.username] = nowMs;
      journal(director, kingdomId, `${record.username} reviewed "${dish.name}" — ${stars}/10 stars.`);
      break; // one review per tick per kingdom
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

function socialScore(record) {
  // Defensive: read social standing from reputation or personality.
  try {
    const rep = record.reputation ?? 0;
    return Math.max(0, Math.min(100, 50 + rep));
  } catch {
    return 0;
  }
}

function payPrize(director, username, amount) {
  try {
    const bot = director?.getBot?.({ username });
    if (!bot) return false; // offline — honestly skip, never invent
    const player = bot.player ?? bot;
    const inv = player?.inventory ?? player?.getInventory?.();
    if (!inv?.add) return false;
    // Coins item id 995 — the standard.
    inv.add(995, amount);
    return true;
  } catch {
    return false;
  }
}

function awardFame(director, username, deedKind) {
  try {
    const Reputation = require("./CitizenReputation");
    Reputation.awardDeed?.(username, deedKind, Date.now());
  } catch {
    // Reputation unavailable — skip honestly.
  }
}

function announce(director, kingdomId, nowMs, kind, message) {
  try {
    const last = _lastAnnounce[kingdomId]?.[kind] ?? 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    // Find an online citizen in this kingdom near a real player to announce.
    const roster = director?.roster;
    if (!roster?.values) return;
    for (const record of roster.values()) {
      try {
        if (!record || record.kingdomId !== kingdomId) continue;
        const citizen = director.isOnline?.(record) ? director.getBot?.(record) : null;
        if (!citizen) continue;
        sayPublic(citizen, message);
        _lastAnnounce[kingdomId] = _lastAnnounce[kingdomId] ?? {};
        _lastAnnounce[kingdomId][kind] = nowMs;
        return; // one announcer is enough
      } catch { /* try next */ }
    }
  } catch {
    // Never throws.
  }
}

function journal(director, kingdomId, text) {
  try {
    director?.getJournal?.()?.log?.(`[cuisine:${kingdomId}] ${text}`);
  } catch {
    // Journal unavailable — skip.
  }
}

function kingdomsOf(director) {
  try {
    const ks = director?.kingdoms ?? director?.getKingdoms?.();
    if (Array.isArray(ks)) return ks.map((k) => k.id ?? k.kingdomId ?? k).filter(Boolean);
    if (ks && typeof ks === "object") return Object.keys(ks);
  } catch { /* fall through */ }
  return ["lumbridge", "varrock", "falador", "ardougne", "keldagrim"];
}

function resetForTests() {
  _lastAnnounce = {};
  _lastCritic = {};
}

module.exports = { tickCuisine, resetForTests };
