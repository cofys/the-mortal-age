"use strict";

/**
 * CitizenAthletics — the athlete profession layer: training, fitness,
 * stadiums, and records.
 *
 * WHAT IT DOES (data tier, free):
 *   - Stadiums: one per kingdom, with capacity, condition, and upkeep.
 *   - Athletes: citizens in the `athlete` career (or athletic traits) who
 *     train in running, wrestling, archery, or racing.
 *   - Training: raises fitness (0–100) and sport skill; fitness decays
 *     slowly when idle. Training is human-paced via the brain action.
 *   - Records: per-sport, per-kingdom records (best marks). Breaking a
 *     record grants fame and is announced.
 *   - Fitness seam: `fitnessFor(username)` exposes a 0–1 fitness level
 *     for CitizenHealth to read (fit citizens recover faster).
 *
 * WHAT IT DOES NOT DO (no-overlap boundaries):
 *   - CitizenSports owns year-round leagues, fixtures, tables, betting.
 *     This module never runs leagues or fixtures; athletes registered here
 *     may appear as competitors in CitizenSports events (read-only seam).
 *   - CitizenHealth owns sickness/HP. This only exposes fitness numbers.
 *   - CitizenEntertainment owns spectator shows. Stadiums here are
 *     training/competition venues, not entertainment venues.
 *
 * Zero LLM. Dirty-flag persistence to citizen-athletics.json.
 */

const { normalizeName } = require("./CitizenBonds");
const fs = require("fs");
const path = require("path");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-athletics.json");

function setSaveFile(p) {
  SAVE_FILE = p;
}

// === Tuning ===
const FITNESS_MAX = 100;
const FITNESS_DECAY_PER_DAY = 2; // idle decay
const TRAINING_GAIN = 3; // per training round
const SKILL_GAIN = 1; // per training round
const STADIUM_UPKEEP_WEEKLY = 500; // coins from kingdom treasury
const RECORD_FAME_POINTS = 8;
const THROTTLE_MS = 6 * 60 * 60 * 1000; // ambient training at most every 6h/kingdom

const SPORTS = ["running", "wrestling", "archery", "racing"];
const SPORT_LABELS = {
  running: "footraces",
  wrestling: "wrestling",
  archery: "archery",
  racing: "horse racing",
};

// === State ===
let state = null;
let dirty = false;

function blankState() {
  return {
    athletes: {}, // norm -> { name, sport, fitness, skill, trainedAt, records }
    stadiums: {}, // kingdomId -> { capacity, condition, upkeepDue }
    records: {}, // `${kingdomId}:${sport}` -> { holder, mark, at }
    lastAmbient: {}, // kingdomId -> ms
  };
}

function ensure() {
  if (!state) state = blankState();
  return state;
}

function norm(name) {
  try { return normalizeName(name); } catch { return String(name || "").toLowerCase().trim(); }
}

// === Athletes ===

function isAthlete(username) {
  const s = ensure();
  return !!s.athletes[norm(username)];
}

function registerAthlete(username, sport) {
  const s = ensure();
  if (!SPORTS.includes(sport)) return null;
  const n = norm(username);
  if (!s.athletes[n]) {
    s.athletes[n] = { name: username, sport, fitness: 20, skill: 1, trainedAt: 0, records: 0 };
    dirty = true;
  }
  return s.athletes[n];
}

function athleteInfo(username) {
  return ensure().athletes[norm(username)] || null;
}

function athletesIn(kingdomId, limit = 10) {
  // Athletes don't carry kingdomId; caller filters by roster. Return all.
  const s = ensure();
  return Object.values(s.athletes).slice(0, limit);
}

function trainAthlete(username, nowMs) {
  const s = ensure();
  const a = s.athletes[norm(username)];
  if (!a) return null;
  a.fitness = Math.min(FITNESS_MAX, a.fitness + TRAINING_GAIN);
  a.skill += SKILL_GAIN;
  a.trainedAt = nowMs;
  dirty = true;
  return a;
}

function decayFitness(nowMs) {
  const s = ensure();
  const dayMs = 24 * 60 * 60 * 1000;
  for (const a of Object.values(s.athletes)) {
    const daysIdle = (nowMs - (a.trainedAt || 0)) / dayMs;
    if (daysIdle >= 1) {
      const loss = Math.floor(daysIdle) * FITNESS_DECAY_PER_DAY;
      const next = Math.max(0, a.fitness - loss);
      if (next !== a.fitness) { a.fitness = next; dirty = true; }
      // Reset the idle clock so decay doesn't compound on old timestamps
      a.trainedAt = nowMs;
    }
  }
}

/** 0–1 fitness level for health/other seams. Unknown athletes read as 0. */
function fitnessFor(username) {
  const a = ensure().athletes[norm(username)];
  if (!a) return 0;
  return Math.max(0, Math.min(1, a.fitness / FITNESS_MAX));
}

// === Stadiums ===

function stadiumFor(kingdomId) {
  return ensure().stadiums[kingdomId] || null;
}

function foundStadium(kingdomId, capacity = 200) {
  const s = ensure();
  if (!s.stadiums[kingdomId]) {
    s.stadiums[kingdomId] = { capacity, condition: 100, upkeepDue: Date.now() + 7 * 24 * 3600 * 1000 };
    dirty = true;
  }
  return s.stadiums[kingdomId];
}

function stadiumTile(kingdomId) {
  // Stadiums sit near the market square; resolved defensively.
  // (CitizenSites has no `marketTile` export — the canonical seam is
  // siteTileByKingdom(kingdomId, kind); the old name silently nulled
  // every stadium, so athletes could never train.)
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const t = siteTileByKingdom(kingdomId, "market");
    if (t) return { x: t.x + 8, y: t.y, z: t.z ?? 0 };
  } catch { /* sites unreadable */ }
  return null;
}

// === Records ===

function recordFor(kingdomId, sport) {
  return ensure().records[`${kingdomId}:${sport}`] || null;
}

/**
 * Attempt to set a record. The mark is derived from the athlete's real
 * skill + fitness (deterministic), never random. Returns the new record
 * or null if the old one stands.
 */
function attemptRecord(username, kingdomId, sport, nowMs) {
  const s = ensure();
  const a = s.athletes[norm(username)];
  if (!a || a.sport !== sport) return null;
  // Deterministic mark: skill and fitness only. Higher is better.
  const mark = Math.round(a.skill * 10 + a.fitness);
  const key = `${kingdomId}:${sport}`;
  const cur = s.records[key];
  if (!cur || mark > cur.mark) {
    s.records[key] = { holder: a.name, mark, at: nowMs };
    a.records += 1;
    dirty = true;
    return s.records[key];
  }
  return null;
}

// === Throttle ===

function ambientDue(kingdomId, nowMs) {
  const last = ensure().lastAmbient[kingdomId] || 0;
  return nowMs - last >= THROTTLE_MS;
}

function markAmbient(kingdomId, nowMs) {
  ensure().lastAmbient[kingdomId] = nowMs;
  dirty = true;
}

// === Persistence ===

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(ensure(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function load() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      state = Object.assign(blankState(), data);
      dirty = false;
      return true;
    }
  } catch { /* corrupt save, start fresh */ }
  return false;
}

function serialize() {
  return JSON.stringify(ensure());
}

function deserialize(json) {
  try {
    const data = JSON.parse(json);
    state = Object.assign(blankState(), data);
    dirty = false;
    return true;
  } catch { return false; }
}

function resetForTests() {
  state = blankState();
  dirty = false;
}

module.exports = {
  SPORTS,
  SPORT_LABELS,
  FITNESS_MAX,
  isAthlete,
  registerAthlete,
  athleteInfo,
  athletesIn,
  trainAthlete,
  decayFitness,
  fitnessFor,
  stadiumFor,
  foundStadium,
  stadiumTile,
  recordFor,
  attemptRecord,
  ambientDue,
  markAmbient,
  save,
  load,
  setSaveFile,
  serialize,
  deserialize,
  resetForTests,
};
