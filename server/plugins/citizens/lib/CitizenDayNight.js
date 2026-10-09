"use strict";

/**
 * CitizenDayNight — the realm's day/night cycle and nocturnal effects.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   The single source of truth for what time of day it is and what that
 *   means for citizens. Time comes from the Sky (Conditions.Fishing's
 *   getTimeOfDay, real server time) with a defensive hour-based fallback.
 *
 * WHAT IT DRIVES:
 *   - Sleep: citizens sleep at night (21:00-05:00); night owls stay up.
 *     The decision layer scores rest higher at night for the weary.
 *   - Work: outdoor labor at night takes a penalty — nobody sane chops
 *     trees in the dark. Thieves get night cover (+8, fewer witnesses).
 *   - Crime: night doubles the crime onset chance (CitizenJusticeLife
 *     reads nightCrimeMultiplier()).
 *   - Danger: monsters are bolder after dark (monsterDanger()).
 *   - Guards: night watch patrols — guards hold their post while others
 *     sleep (CitizenDayNightLife announces patrols near players).
 *   - Lamps: street lamps are lit at dusk/night/dawn (lampsLit()).
 *   - Chat: "what time is it" / "is it night" answered from here.
 *
 * Time-of-day bands (from the Sky, same as fishing conditions):
 *   dawn  05:00-08:00, day 08:00-17:00, dusk 17:00-20:00, night 20:00-05:00
 *
 * Persistence: only dusk/dawn/night transition announcements are saved
 * (so a restart doesn't re-announce the same transition). Dirty-flag
 * pattern like the other lib modules. Plain-node testable.
 */

// === Time-of-day bands (mirrors Conditions.Fishing.TIME) ===
const TIME = Object.freeze({
  DAWN: "dawn",
  DAY: "day",
  DUSK: "dusk",
  NIGHT: "night",
});

// Night work penalty: outdoor labor in the dark is miserable and slow.
const NIGHT_WORK_PENALTY = -15;
// Thieves love the dark: fewer witnesses.
const NIGHT_THIEF_BONUS = 8;
// Night doubles opportunistic crime.
const NIGHT_CRIME_MULTIPLIER = 2.0;
// Monster danger: 1.0 by day, higher at night.
const NIGHT_MONSTER_DANGER = 2.5;

// Sleep window: most citizens sleep 21:00-05:00 (server-local hour).
const SLEEP_START_HOUR = 21;
const SLEEP_END_HOUR = 5;

// === Persistence (transition announcements, dirty-flag) ===
let lastAnnouncedTransition = null; // "dusk"|"night"|"dawn" — which we last announced
let dirty = false;

function markDirty() {
  dirty = true;
}

/**
 * Time of day right now. Defensive: if the Sky is unavailable, falls back
 * to hour math on server-local time (same bands as the Sky).
 * @param {number} [nowMs=Date.now()]
 * @returns {"dawn"|"day"|"dusk"|"night"}
 */
function timeOfDay(nowMs = Date.now()) {
  try {
    const sky = require("../../skills/fishing/Conditions.Fishing");
    const t = sky.getTimeOfDay?.(new Date(nowMs));
    if (t === TIME.DAWN || t === TIME.DAY || t === TIME.DUSK || t === TIME.NIGHT) return t;
  } catch {
    // fall through to hour math
  }
  const hour = new Date(nowMs).getHours();
  if (hour >= 5 && hour < 8) return TIME.DAWN;
  if (hour >= 8 && hour < 17) return TIME.DAY;
  if (hour >= 17 && hour < 20) return TIME.DUSK;
  return TIME.NIGHT;
}

function isNight(nowMs) {
  return timeOfDay(nowMs) === TIME.NIGHT;
}
function isDay(nowMs) {
  return timeOfDay(nowMs) === TIME.DAY;
}
function isDawn(nowMs) {
  return timeOfDay(nowMs) === TIME.DAWN;
}
function isDusk(nowMs) {
  return timeOfDay(nowMs) === TIME.DUSK;
}

/**
 * Is this the hour most citizens sleep? Night is for sleeping; night owls
 * are the exception (see isNightOwl).
 */
function isSleepHour(nowMs = Date.now()) {
  const hour = new Date(nowMs).getHours();
  return hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR;
}

/**
 * Is this citizen a night owl? Pure. Night owls stay up late and visit
 * taverns; everyone else heads home at dusk.
 * @param {object} record — roster record with personality
 */
function isNightOwl(record) {
  try {
    const traits = new Set(record?.personality?.traits ?? []);
    const quirk = String(record?.personality?.quirk ?? "").toLowerCase();
    if (traits.has("night-owl") || traits.has("nocturnal")) return true;
    if (quirk.includes("night owl") || quirk.includes("stays up late") || quirk.includes("never sleeps")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Outdoor work penalty right now (subtracted from outdoor activity scores).
 * Night is dark and dangerous; dusk is fine.
 */
function nightWorkPenalty(nowMs = Date.now()) {
  return isNight(nowMs) ? NIGHT_WORK_PENALTY : 0;
}

/** Crime onset multiplier: night doubles opportunistic crime. */
function nightCrimeMultiplier(nowMs = Date.now()) {
  return isNight(nowMs) ? NIGHT_CRIME_MULTIPLIER : 1.0;
}

/** Monster danger level: 1.0 by day, higher at night. */
function monsterDanger(nowMs = Date.now()) {
  return isNight(nowMs) ? NIGHT_MONSTER_DANGER : 1.0;
}

/** Are the street lamps lit? Dusk, night, and dawn. */
function lampsLit(nowMs = Date.now()) {
  const t = timeOfDay(nowMs);
  return t === TIME.DUSK || t === TIME.NIGHT || t === TIME.DAWN;
}

/**
 * Human description of the time: "the dead of night", "early morning"...
 * Pure.
 */
function describe(nowMs = Date.now()) {
  const t = timeOfDay(nowMs);
  const hour = new Date(nowMs).getHours();
  switch (t) {
    case TIME.DAWN:
      return hour < 6 ? "the small hours before dawn" : "early morning";
    case TIME.DAY:
      if (hour < 11) return "morning";
      if (hour < 14) return "midday";
      return "afternoon";
    case TIME.DUSK:
      return "dusk";
    case TIME.NIGHT:
    default:
      if (hour >= 23 || hour < 2) return "the dead of night";
      return "night";
  }
}

/**
 * Mark a transition as announced (dusk/night/dawn). Returns true if this
 * is a NEW transition worth announcing (not a repeat).
 */
function noteTransitionAnnounced(transition) {
  if (lastAnnouncedTransition === transition) return false;
  lastAnnouncedTransition = transition;
  markDirty();
  return true;
}

/** Last announced transition (for tests/seams). */
function lastTransition() {
  return lastAnnouncedTransition;
}

/** Reset transition state (tests). */
function _resetForTests() {
  lastAnnouncedTransition = null;
  dirty = false;
}

/** Save seam: returns true if dirty (caller logs "citizen daynight saved"). */
function save() {
  if (!dirty) return false;
  dirty = false;
  return true;
}

module.exports = {
  TIME,
  NIGHT_WORK_PENALTY,
  NIGHT_THIEF_BONUS,
  NIGHT_CRIME_MULTIPLIER,
  NIGHT_MONSTER_DANGER,
  SLEEP_START_HOUR,
  SLEEP_END_HOUR,
  timeOfDay,
  isNight,
  isDay,
  isDawn,
  isDusk,
  isSleepHour,
  isNightOwl,
  nightWorkPenalty,
  nightCrimeMultiplier,
  monsterDanger,
  lampsLit,
  describe,
  noteTransitionAnnounced,
  lastTransition,
  _resetForTests,
  save,
};
