"use strict";

/**
 * CitizenDiplomacyLife — the slow-tick dynamics for the covert and
 * dynastic layer: marriage negotiations and espionage.
 *
 * WHAT IT DOES (wired into the director slow tick, try/catch, never throws):
 *   - Marriage negotiations: pending proposals advance at most one court
 *     round per NEGOTIATION_ROUND_MS. Accepted proposals get their REAL
 *     effects applied (marriage-bond flags, tension cooling); refused ones
 *     die honestly; countered ones haggle on.
 *   - Espionage: active spy missions gather intel (real engine reads) and
 *     roll discovery. Caught spies cost real border tension.
 *   - Announcements: sealed marriages and caught spies are announced via
 *     sayPublic where real players can hear them, and journaled.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented effects: every number lands through a real API.
 *   - Never touches lib/*2 (frozen).
 */

const Dip = require("./CitizenDiplomacy");

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const { normalizeName } = require("./CitizenBonds");
    const record = director?.roster?.get?.(normalizeName(username));
    const player = record && director.isOnline?.(record) ? director.getBot?.(record) : null;
    if (player) sayPublic(player, text);
  } catch {
    // speech is best-effort
  }
}

function journal(director, text, data = {}) {
  try {
    director?.journal?.("diplomacy", text, data);
  } catch {
    // journaling is best-effort
  }
}

function prettyKingdom(id) {
  const s = String(id ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Slow-tick entry. director: the CitizenDirector. nowMs: real time.
 * Never throws.
 */
function tickCovertDiplomacy(director, nowMs = Date.now()) {
  try {
    advanceMarriages(director, nowMs);
  } catch (error) {
    director?.log?.("diplomacy marriages failed", { error: String(error?.message ?? error) });
  }
  try {
    runEspionage(director, nowMs);
  } catch (error) {
    director?.log?.("diplomacy espionage failed", { error: String(error?.message ?? error) });
  }
}

function advanceMarriages(director, nowMs) {
  const seen = new Set();
  for (const k of Dip.kingdoms()) {
    for (const pending of Dip.pendingMarriagesFor(k)) {
      if (seen.has(pending.id)) continue;
      seen.add(pending.id);
      let outcome;
      try {
        outcome = Dip.negotiateRound(pending.id, nowMs);
      } catch {
        continue; // one bad proposal never breaks the tick
      }
      if (outcome === "accepted") {
        const full = Dip.marriageById(pending.id);
        let effects = [];
        try {
          effects = Dip.applyMarriageEffects(full);
        } catch {
          // effects are best-effort; the alliance stands
        }
        const text = `Hear ye! A royal marriage seals an alliance between ${prettyKingdom(full.from)} and ${prettyKingdom(full.to)}.`;
        journal(director, text, { marriage: full.id, effects });
        if (full.broker) sayPublicTo(director, full.broker, text);
      } else if (outcome === "refused") {
        journal(director, `${prettyKingdom(pending.to)} refused the marriage alliance from ${prettyKingdom(pending.from)}.`, {
          marriage: pending.id,
        });
      } else if (outcome === "expired") {
        journal(director, `The marriage proposal between ${prettyKingdom(pending.from)} and ${prettyKingdom(pending.to)} died unanswered.`, {
          marriage: pending.id,
        });
      }
      // "countered" and "waiting" are quiet — dowries are haggled in private.
    }
  }
}

function runEspionage(director, nowMs) {
  const roster = director?.roster;
  if (!roster?.values) return;
  for (const record of roster.values()) {
    let mission = null;
    try {
      mission = Dip.spyMissionFor(record?.username ?? record?.displayName ?? "");
    } catch {
      continue;
    }
    if (!mission) continue;
    try {
      if (!mission.intel) {
        const intel = Dip.gatherIntel(mission.id, nowMs);
        if (intel) {
          journal(director, `${mission.spy} returned from ${prettyKingdom(mission.targetKingdom)} with word of its levies.`, {
            mission: mission.id,
          });
        }
      } else {
        const discovered = Dip.discoveryRoll(mission.id, nowMs);
        if (discovered) {
          const text = `A ${prettyKingdom(mission.homeKingdom)} spy was caught in ${prettyKingdom(mission.targetKingdom)}! The border seethes.`;
          journal(director, text, { mission: mission.id });
          sayPublicTo(director, mission.spy, "They caught me. Run.");
        }
      }
    } catch {
      // one bad mission never breaks the tick
    }
  }
}

module.exports = { tickCovertDiplomacy };
