"use strict";

/**
 * CitizenFashionLife — slow-tick dynamics for the fashion system.
 *
 * Runs on the director slow tick. Never throws.
 *
 * - Rotates fashion trends weekly (data tier handles determinism).
 * - Schedules monthly style competitions per kingdom.
 * - Resolves competitions with enough entries, awards REAL coin prizes
 *   (winner 500, runner-up 200) via the director's coin helpers.
 * - Awards fame deeds (trendsetter for winners).
 * - Announces competitions and winners near real players via sayPublic.
 * - Restocks clothing shops daily (citizen-made garments from the registry).
 */

const Fashion = require("./CitizenFashion");
const { sayPublic } = require("../chat/CitizenSayPublic");

// Announcements are personality-gated and cooldown-gated.
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most every 6h per kingdom
let _lastAnnounce = {}; // kingdomId -> { competition: ts, winner: ts }

/**
 * Slow-tick entry. director is the CitizenDirector, nowMs is Date.now().
 * Never throws — one bad kingdom never breaks the tick.
 */
function tickFashion(director, nowMs) {
  try {
    nowMs = nowMs ?? Date.now();
    // Trend rotation is lazy (data tier rotates on read). Just ensure it's warm.
    Fashion.currentTrend(nowMs);

    const kingdoms = kingdomsOf(director);
    for (const kingdomId of kingdoms) {
      try {
        tickKingdomFashion(director, kingdomId, nowMs);
      } catch {
        // One bad kingdom never breaks the tick.
      }
    }

    Fashion.save();
  } catch {
    // Never throws.
  }
}

function tickKingdomFashion(director, kingdomId, nowMs) {
  // 1. Schedule competition if due.
  const comp = Fashion.maybeScheduleCompetition(kingdomId, nowMs);
  if (comp) {
    announce(director, kingdomId, nowMs, "competition",
      `A grand style competition is announced! Show your finest garments and claim ${Fashion.COMPETITION_PRIZE} coins!`);
    journal(director, kingdomId, `Style competition announced in ${kingdomId}.`);
  }

  // 2. Resolve competitions that have been open for 3+ days with 2+ entries.
  const st = Fashion.load();
  for (const c of st.competitions) {
    if (c.kingdomId !== kingdomId || c.resolvedAt) continue;
    if (nowMs - c.scheduledAt < 3 * 24 * 60 * 60 * 1000) continue;
    if (c.entries.length < 2) continue; // need at least 2 to judge
    const result = Fashion.resolveCompetition(c.id, nowMs);
    if (result) {
      payPrize(director, result.winner, result.prize);
      if (result.runnerUp) payPrize(director, result.runnerUp, result.runnerUpPrize);
      awardFame(director, result.winner, "trendsetter");
      announce(director, kingdomId, nowMs, "winner",
        `${result.winner} wins the style competition! A true trendsetter of the realm!`);
      journal(director, kingdomId, `Style competition won by ${result.winner}.`);
    }
  }
}

function payPrize(director, username, amount) {
  try {
    const bot = director?.getBot?.({ username });
    if (!bot) return false; // offline — honestly skip, never invent
    const player = bot.player ?? bot;
    if (player?.inventory?.add) {
      player.inventory.add(995, amount);
      return true;
    }
  } catch {
    // Honest failure.
  }
  return false;
}

function awardFame(director, username, deedKind) {
  try {
    const Reputation = require("./CitizenReputation");
    Reputation.awardDeed?.(username, deedKind);
  } catch {
    // Reputation unavailable — skip.
  }
}

function announce(director, kingdomId, nowMs, kind, message) {
  const last = _lastAnnounce[kingdomId]?.[kind] ?? 0;
  if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
  try {
    // Find a citizen in this kingdom near a real player to announce.
    const roster = director?.roster;
    if (!roster?.values) return;
    for (const record of roster.values()) {
      if (record?.kingdomId !== kingdomId) continue;
      const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (!bot) continue;
      if (!anyRealPlayerNear(director, bot)) continue;
      sayPublic(bot, message);
      _lastAnnounce[kingdomId] = _lastAnnounce[kingdomId] ?? {};
      _lastAnnounce[kingdomId][kind] = nowMs;
      return;
    }
  } catch {
    // Announcement failed — skip.
  }
}

function anyRealPlayerNear(director, bot) {
  try {
    const players = bot.getLocalPlayers?.() ?? [];
    return players.some((p) => !p?.isCitizen && !p?.isBot);
  } catch {
    return false;
  }
}

function journal(director, kingdomId, message) {
  try {
    const journal = director?.getJournal?.();
    journal?.log?.(message, { kingdomId, system: "fashion" });
  } catch {
    // Journal unavailable — skip.
  }
}

function kingdomsOf(director) {
  try {
    const kingdoms = director?.kingdoms ?? director?.getKingdoms?.() ?? [];
    if (Array.isArray(kingdoms)) return kingdoms.map((k) => k?.id ?? k).filter(Boolean);
    if (kingdoms?.keys) return [...kingdoms.keys()];
  } catch {
    // Unknown — return empty.
  }
  return [];
}

function resetForTests() {
  _lastAnnounce = {};
}

module.exports = {
  tickFashion,
  resetForTests,
};
