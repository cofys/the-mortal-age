"use strict";

/**
 * CitizenRapportEvents — real proximity observations for the citizen↔citizen
 * rapport graph (brain layer).
 *
 * The rapport engine (CitizenRelationships) was starving: its only event
 * source was clan outings. This module feeds it real engine observations:
 * two roster citizens standing near each other accrue "workedAlongside"
 * rapport, because player.getLocalPlayers() includes citizen bots. Being
 * around each other IS the shared life friendships form from.
 *
 * Everything here is a real observation (engine proximity). No hash-derived
 * fiction, no LLM in the tick, no new behavior — only rapport observations.
 * One bad record/bot never breaks the tick, and writes stay roster-gated
 * (player bonds live elsewhere).
 */

const { noteInteraction, pairKey } = require("./CitizenRelationships");
const { normalizeName } = require("../lib/CitizenBonds");

// One workedAlongside accrual per pair per cooldown — a slow trickle, not a
// firehose. The brain's decay (1 per slow tick) keeps it honest: proximity
// alone maintains warmth; it takes real conversation to forge friendship.
const ACCRUAL_COOLDOWN_MS = 8 * 60 * 1000;

// pairKey -> timestamp of last proximity accrual.
const lastAccrualAt = new Map();
const MAX_TRACKED_PAIRS = 10000;

/** Roster-gate helper, shared with the chat hook in CitizenHeardReactions. */
function isRosterCitizen(director, name) {
  try {
    return !!director?.roster?.get?.(normalizeName(name));
  } catch {
    return false;
  }
}

function pruneAccruals(nowMs) {
  if (lastAccrualAt.size <= MAX_TRACKED_PAIRS) return;
  const cutoff = nowMs - ACCRUAL_COOLDOWN_MS * 2;
  for (const [key, at] of lastAccrualAt) {
    if (at < cutoff) lastAccrualAt.delete(key);
  }
}

/**
 * Slow-tick event source, called from the director's data tick right after
 * bond formation. For each online roster citizen, the engine's local-player
 * list is scanned; every co-located roster citizen accrues one
 * "workedAlongside" interaction per cooldown window (personalities modulate
 * via the real records when available).
 *
 * @returns {number} pairs accrued this pass
 */
function tickProximityRapport(director, nowMs = Date.now()) {
  if (!director?.roster) return 0;
  pruneAccruals(nowMs);
  let accrued = 0;
  for (const record of director.roster.values()) {
    let bot = null;
    try {
      bot = director.getBot?.(record) ?? null;
    } catch {
      continue; // one bad record never breaks the tick
    }
    if (!bot) continue; // offline or not spawned
    let locals;
    try {
      locals = bot.getLocalPlayers?.() ?? [];
    } catch {
      continue; // one bad bot never breaks the tick
    }
    for (const local of locals) {
      try {
        if (local === bot) continue;
        const username = local.getUsername?.();
        if (!username) continue;
        if (normalizeName(username) === normalizeName(record.username)) continue;
        const recB = director.roster.get(normalizeName(username));
        if (!recB) continue; // real players and strangers build no rapport
        const key = pairKey(record.username, recB.username);
        const last = lastAccrualAt.get(key) ?? 0;
        if (nowMs - last < ACCRUAL_COOLDOWN_MS) continue;
        noteInteraction(
          record.username,
          recB.username,
          "workedAlongside",
          record.personality ?? null,
          recB.personality ?? null
        );
        lastAccrualAt.set(key, nowMs);
        accrued += 1;
      } catch {
        // One bad local never breaks the tick.
      }
    }
  }
  return accrued;
}

/** Test seam: clear proximity cooldown state. */
function resetForTests() {
  lastAccrualAt.clear();
}

module.exports = {
  tickProximityRapport,
  isRosterCitizen,
  resetForTests,
  ACCRUAL_COOLDOWN_MS,
};
