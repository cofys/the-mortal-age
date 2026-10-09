"use strict";

/**
 * CitizenRelationships — citizen↔citizen bond FORMATION (brain layer).
 *
 * Do not confuse with lib/CitizenRelationships.js: that module makes bonds
 * *felt toward players* (friend-login greetings, farewells, warnings). THIS
 * module is the formation dynamics for citizen↔citizen bonds: rapport builds
 * from real interactions, modulated by personality compatibility, and
 * promotes into the CitizenBonds graph (friend / enemy) at thresholds.
 * Rivalries get the same teeth as enemies — cold shoulder in chat, no trade
 * — because they go through the existing addEnemy path.
 *
 * Design rules (Jon's model: citizens play the game like humans):
 *   - Rapport comes from REAL events only: conversations that happened
 *     (CitizenSocial threads), greetings given, help/trade interactions.
 *     Nothing is hash-derived; first impressions seed from the two real
 *     personality records.
 *   - Personality compatibility is a pure function of the two citizens'
 *     actual traits. Shared traits warm things; opposing traits cool them.
 *   - Thresholds are high enough that a single argument doesn't end a
 *     friendship — rivalries are earned, like with real players.
 *
 * Data tier, zero LLM. Tick-safe (every external touch wrapped).
 */

const { isFriend, isEnemy, addFriend, addEnemy } = require("../lib/CitizenBonds");
const { getJournal } = require("../lib/CitizenJournal");

// Rapport bounds and thresholds.
const RAPPORT_MIN = -100;
const RAPPORT_MAX = 100;
const FRIEND_AT = 50; // sustained warmth becomes friendship
const RIVAL_AT = -50; // sustained hostility becomes rivalry
const DECAY_PER_TICK = 1; // rapport drifts toward 0 each slow tick
const FIRST_IMPRESSION_SCALE = 15; // |compatibility| * this on first meeting

// Interaction weights: positive builds, negative burns.
const INTERACTION_WEIGHTS = Object.freeze({
  greeted: 2,
  chatted: 4,
  workedAlongside: 3,
  traded: 5,
  helped: 8,
  argued: -6,
  insulted: -12,
  fought: -18,
});

// Trait pairs that grate on each other.
const OPPOSING_TRAITS = Object.freeze([
  ["chatty", "taciturn"],
  ["cheerful", "gruff"],
  ["generous", "greedy"],
  ["trusting", "suspicious"],
  ["easygoing", "gruff"],
  ["warm", "guarded"],
]);

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

// Symmetric pair key — rapport is mutual.
function pairKey(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na < nb ? `${na}>${nb}` : `${nb}>${na}`;
}

// pairKey -> { rapport, updatedAt }
const rapport = new Map();
const MAX_PAIRS = 5000;

function traitSet(personality) {
  return new Set(
    Array.isArray(personality?.traits) ? personality.traits : []
  );
}

/**
 * Personality compatibility, -1..1. Pure function of the two real
 * personality records. Shared traits warm it; opposing trait pairs cool it.
 */
function compatibility(pA, pB) {
  const a = traitSet(pA);
  const b = traitSet(pB);
  let score = 0;
  let shared = 0;
  for (const t of a) {
    if (b.has(t)) {
      shared += 1;
      if (shared <= 4) score += 0.12; // cap the echo chamber
    }
  }
  for (const [x, y] of OPPOSING_TRAITS) {
    if ((a.has(x) && b.has(y)) || (a.has(y) && b.has(x))) {
      score -= 0.25;
    }
  }
  return Math.max(-1, Math.min(1, score));
}

function clampRapport(v) {
  return Math.max(RAPPORT_MIN, Math.min(RAPPORT_MAX, v));
}

/**
 * Record a real interaction between two citizens. First contact seeds
 * rapport from personality compatibility (first impressions); later
 * interactions move it by the kind's weight, amplified when the pair is
 * compatible (warm pairs warm faster; hostile pairs burn faster).
 */
function noteInteraction(aName, bName, kind, pA = null, pB = null) {
  const na = normalizeName(aName);
  const nb = normalizeName(bName);
  if (!na || !nb || na === nb) return 0;
  const weight = INTERACTION_WEIGHTS[kind];
  if (!Number.isFinite(weight)) return 0;

  const key = pairKey(na, nb);
  const compat = compatibility(pA, pB);
  let entry = rapport.get(key);
  let value;
  if (!entry) {
    // First impression: compatibility sets the starting temperature.
    value = compat * FIRST_IMPRESSION_SCALE + weight * 0.5;
  } else {
    const amp =
      weight > 0 ? 1 + 0.5 * Math.max(0, compat) : 1 + 0.5 * Math.max(0, -compat);
    value = entry.rapport + weight * amp;
  }
  value = clampRapport(Math.round(value * 10) / 10);
  rapport.set(key, { rapport: value, updatedAt: Date.now() });
  // Write through to the persistent bond memory (quiet: the brain tick owns
  // promotion + journals; this just makes the score survive restarts and
  // visible to the LLM mouth via bondSummary).
  try {
    require("../lib/CitizenSocialBonds").recordInteraction(na, nb, kind, {
      mutual: true,
      quiet: true,
    });
  } catch {
    // Persistence must never break formation.
  }
  return value;
}

function rapportOf(aName, bName) {
  const entry = rapport.get(pairKey(aName, bName));
  return entry ? entry.rapport : 0;
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "social", text);
  } catch {
    // Never break the tick.
  }
}

/**
 * Slow-tick maintenance, called from the director's data tick:
 * rapport decays toward indifference; crossings promote into the bonds
 * graph (friends / rivals) with a journal line so the LLM mouth knows.
 * Only promotes pairs where both are roster citizens — player befriending
 * stays in CitizenSocialMechanics.
 */
function tickRelationships(director, nowMs = Date.now()) {
  if (!director?.roster) return { friends: 0, rivals: 0 };
  const isRosterCitizen = (name) => {
    try {
      return director.roster.has(normalizeName(name));
    } catch {
      return false;
    }
  };
  let friends = 0;
  let rivals = 0;
  for (const [key, entry] of rapport) {
    // Decay toward indifference.
    if (entry.rapport > 0) entry.rapport = Math.max(0, entry.rapport - DECAY_PER_TICK);
    else if (entry.rapport < 0) entry.rapport = Math.min(0, entry.rapport + DECAY_PER_TICK);
    entry.updatedAt = nowMs;

    const [na, nb] = key.split(">");
    if (!isRosterCitizen(na) || !isRosterCitizen(nb)) continue;

    try {
      if (entry.rapport >= FRIEND_AT && !isFriend(na, nb)) {
        if (addFriend(na, nb)) {
          addFriend(nb, na); // citizen friendships are mutual
          journalEvent(na, `Became good friends with ${nb}.`);
          journalEvent(nb, `Became good friends with ${na}.`);
          friends += 1;
        }
      } else if (entry.rapport <= RIVAL_AT && !isEnemy(na, nb)) {
        if (addEnemy(na, nb)) {
          addEnemy(nb, na); // rivalries are mutual
          journalEvent(na, `Fell out with ${nb} — bad blood now.`);
          journalEvent(nb, `Fell out with ${na} — bad blood now.`);
          rivals += 1;
        }
      }
    } catch {
      // One bad pair never breaks the tick.
    }
  }
  // Bound the map: drop stale, near-indifferent pairs.
  if (rapport.size > MAX_PAIRS) {
    const cutoff = nowMs - 7 * 24 * 3600 * 1000;
    for (const [key, entry] of rapport) {
      if (Math.abs(entry.rapport) < 5 && entry.updatedAt < cutoff) {
        rapport.delete(key);
      }
    }
  }
  return { friends, rivals };
}

/** Test seam: clear all rapport state. */
function resetForTests() {
  rapport.clear();
}

/** Test seam: number of tracked pairs. */
function pairCount() {
  return rapport.size;
}

module.exports = {
  compatibility,
  noteInteraction,
  rapportOf,
  tickRelationships,
  pairKey,
  resetForTests,
  pairCount,
  FRIEND_AT,
  RIVAL_AT,
  INTERACTION_WEIGHTS,
};
