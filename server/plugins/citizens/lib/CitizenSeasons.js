"use strict";

/**
 * CitizenSeasons — the realm's seasonal calendar and climate effects.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   The single source of truth for what season it is and what that means.
 *   Seasons are deterministic real-world date math (same convention as the
 *   festival calendar): spring Mar-May, summer Jun-Aug, autumn Sep-Nov,
 *   winter Dec-Feb.
 *
 * WHAT IT DRIVES:
 *   - Health: CitizenHealthLife asks isWinter() for the cold/flu multiplier
 *     (replaces the old hardcoded month check).
 *   - Farming: growthMultiplier() combines season and weather — rain on a
 *     spring day is the fastest growth in the realm; winter slows everything.
 *   - Work: outdoorWorkPenalty() — nobody sane builds furniture frames in a
 *     thunderstorm; storms shut down outdoor labor.
 *   - Behavior: warmClothesNeeded() — winter means cloaks and furs, which
 *     citizens mention near players and journal about.
 *   - Festivals: seasonalFestival() maps each season to its festival, so
 *     chat and journals can say "Harvest Home is the autumn festival".
 *
 * Persistence: only season-transition announcements are saved (so a restart
 * doesn't re-announce the same season). Dirty-flag pattern like the other
 * lib modules. Plain-node testable: CitizenSeasons.test.js.
 */

const { agentRng } = require("./humanizer");

// === The four seasons: month is 0-indexed (0 = January) ===
const SEASONS = Object.freeze({
  spring: { months: [2, 3, 4], label: "Spring", mood: "hopeful" },
  summer: { months: [5, 6, 7], label: "Summer", mood: "languid" },
  autumn: { months: [8, 9, 10], label: "Autumn", mood: "industrious" },
  winter: { months: [11, 0, 1], label: "Winter", mood: "hardy" },
});

// Growth per season, before weather. Spring is planting season; winter the
// fields sleep.
const SEASON_GROWTH = Object.freeze({
  spring: 1.25,
  summer: 1.1,
  autumn: 1.0,
  winter: 0.7,
});

// Cold/flu onset multiplier per season (winter is the sick season).
const SEASON_COLD_MULT = Object.freeze({
  spring: 1.0,
  summer: 0.8,
  autumn: 1.0,
  winter: 2.0,
});

// Weather growth multiplier: rain waters the crops. Storms are too violent
// to help — they flatten seedlings (growth stalls, and see outdoor penalty).
const WEATHER_GROWTH = Object.freeze({
  clear: 1.0,
  overcast: 1.0,
  rain: 1.5,
  storm: 0.8,
});

// Outdoor work penalty by weather (subtracted from outdoor activity scores).
// A storm is genuinely dangerous; rain is merely miserable.
const WEATHER_WORK_PENALTY = Object.freeze({
  clear: 0,
  overcast: 0,
  rain: -8,
  storm: -30,
});

// Which festivals belong to which season (ids from CitizenFestivals).
const SEASON_FESTIVALS = Object.freeze({
  spring: "springtide",
  summer: "midsummer",
  autumn: "harvest-home",
  winter: "embernight",
});

/**
 * Which season is it? Pure date math.
 * @param {number} nowMs - timestamp
 * @returns {"spring"|"summer"|"autumn"|"winter"}
 */
function seasonOf(nowMs) {
  const month = new Date(nowMs).getMonth();
  for (const [name, def] of Object.entries(SEASONS)) {
    if (def.months.includes(month)) return name;
  }
  return "spring"; // unreachable, but total
}

/** True in December, January, February. */
function isWinter(nowMs) {
  return seasonOf(nowMs) === "winter";
}

/** Cold/flu onset multiplier for the current season. */
function coldMultiplier(nowMs) {
  return SEASON_COLD_MULT[seasonOf(nowMs)] ?? 1.0;
}

/**
 * Crop growth multiplier combining season and weather.
 * Rain in spring: 1.25 * 1.5 = 1.875x. Storm in winter: 0.7 * 0.8 = 0.56x.
 * Weather may be null/unknown — defaults to clear.
 */
function growthMultiplier(nowMs, weather) {
  const s = SEASON_GROWTH[seasonOf(nowMs)] ?? 1.0;
  const w = WEATHER_GROWTH[String(weather ?? "clear").toLowerCase()] ?? 1.0;
  return s * w;
}

/**
 * Outdoor work score penalty for the current weather. Storms shut down
 * outdoor labor; rain just makes it miserable.
 */
function outdoorWorkPenalty(weather) {
  return WEATHER_WORK_PENALTY[String(weather ?? "clear").toLowerCase()] ?? 0;
}

/** True when the season demands warm clothes (winter). */
function warmClothesNeeded(nowMs) {
  return isWinter(nowMs);
}

/** Festival id for a season (see CitizenFestivals.FESTIVALS). */
function seasonalFestival(season) {
  return SEASON_FESTIVALS[season] ?? null;
}

/**
 * Human description of where we are in the season, for chat/journals.
 * "early winter", "mid-spring", "late autumn".
 */
function describe(nowMs) {
  const season = seasonOf(nowMs);
  const day = new Date(nowMs).getDate();
  const part = day <= 10 ? "early" : day >= 21 ? "late" : "mid";
  return `${part} ${season}`;
}

/**
 * How much bonus growth-time (ms) a rainy tick grants a farm, attributable
 * to the WEATHER alone (the seasonal baseline is the engine's own growth
 * clock running in real time — we only add what the rain contributes).
 *
 * The caller advances the real farm clock by this extra amount via
 * botFarm.advanceFarm(farm, now + bonus) — the same engine function the
 * farming tick uses, just with more elapsed time. Pure.
 *
 * A 60s slow tick in spring rain grants 60s * 1.25 * (1.5 - 1) = 37.5s of
 * bonus growth. Clear weather grants nothing; storms grant nothing (they
 * flatten seedlings — see outdoorWorkPenalty).
 */
const RAIN_BONUS_TICK_MS = 60 * 1000;
function rainBonusMs(nowMs, weather) {
  const seasonMult = SEASON_GROWTH[seasonOf(nowMs)] ?? 1.0;
  const weatherMult = WEATHER_GROWTH[String(weather ?? "clear").toLowerCase()] ?? 1.0;
  if (weatherMult <= 1.0) return 0;
  return Math.round(RAIN_BONUS_TICK_MS * seasonMult * (weatherMult - 1.0));
}

// === Persistence: season-change announcements (dirty-flag) ===

const SAVE_PATH = "data/saves/citizen-seasons.json";
let announcedSeason = null; // "winter" etc — the last season we announced
let dirty = false;

function load() {
  try {
    const fs = require("fs");
    const path = require("path");
    const p = path.join(process.cwd(), SAVE_PATH);
    if (!fs.existsSync(p)) return;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof data?.announcedSeason === "string") announcedSeason = data.announcedSeason;
  } catch {
    // Corrupt or missing save: start fresh, never break boot.
  }
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const p = path.join(process.cwd(), SAVE_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ announcedSeason, savedAt: Date.now() }, null, 2));
    fs.renameSync(tmp, p);
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Test seam: inject the announced season. */
function _setAnnouncedSeason(s) {
  announcedSeason = s;
  dirty = true;
}
/** Test seam: reset persistence state. */
function _resetState() {
  announcedSeason = null;
  dirty = false;
}

load();

module.exports = {
  SEASONS,
  SEASON_GROWTH,
  WEATHER_GROWTH,
  seasonOf,
  isWinter,
  coldMultiplier,
  growthMultiplier,
  outdoorWorkPenalty,
  warmClothesNeeded,
  seasonalFestival,
  describe,
  rainBonusMs,
  RAIN_BONUS_TICK_MS,
  save,
  // Test seams:
  _setAnnouncedSeason,
  _resetState,
  _getAnnouncedSeason: () => announcedSeason,
};
