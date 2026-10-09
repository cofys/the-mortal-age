"use strict";

/**
 * CitizenHealth — the data tier for citizen sickness, injury, and healing.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   illness records {username, illness, severity, startedAt, treatedBy},
 *   the illness catalog (cold, flu, food poisoning, wound infection,
 *   plague), hospital records per kingdom, and pure helpers:
 *   isSick, workPenaltyFor (0..60), mortalityBonusFor (extra death chance),
 *   plus hospitalOfKingdom / patientsOfKingdom.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Onset, spread, recovery, and healer treatment live
 *     in lib/CitizenHealthLife.js (the director ticks that).
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - Cures are honest: natural recovery over the illness duration, a
 *     healer's visit, or a clean herb administered as medicine. Medicine
 *     consumes REAL clean herbs from a real inventory — the herb item ids
 *     are read from the Herblore plugin at runtime, never hardcoded.
 *
 * DESIGN NOTES:
 *   - Severity drives everything: work penalty = severity * 15, so a
 *     plague (severity 4) is -60 — the citizen effectively cannot work.
 *   - Contagion is real state: cold/flu/plague spread between citizens
 *     of the same kingdom on the slow tick (handled in HealthLife).
 *   - Plague is the only illness that can kill: mortalityBonusFor returns
 *     a small extra per-tick death chance, read defensively by
 *     CitizenFunerals.mortalityChanceFor. Everything else just makes
 *     citizens miserable and unproductive.
 *
 * Persisted to data/saves/citizen-health.json (dirty-flag pattern, never
 * committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-health.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- illness catalog ---------------------------------------------------------
// durationDays: [min, max] natural recovery window.
// severity: 1 (sniffles) .. 4 (plague).
// contagious: 0 = no, otherwise per-tick spread chance to a healthy
//   kingdom-mate (scaled down by the tick code).
// cure: "rest" (time heals), "herb" (needs a clean herb as medicine),
//   "healer" (needs a healer's visit; herb cures also benefit from one).

const ILLNESSES = Object.freeze({
  cold: Object.freeze({
    label: "a common cold",
    durationDays: [2, 3],
    severity: 1,
    contagious: 0.02,
    cure: "rest",
    symptom: "sniffling and sneezing",
  }),
  flu: Object.freeze({
    label: "the flu",
    durationDays: [4, 6],
    severity: 2,
    contagious: 0.05,
    cure: "herb",
    symptom: "feverish and aching all over",
  }),
  foodpoison: Object.freeze({
    label: "food poisoning",
    durationDays: [1, 2],
    severity: 2,
    contagious: 0,
    cure: "rest",
    symptom: "clutching their stomach",
  }),
  infection: Object.freeze({
    label: "a wound infection",
    durationDays: [3, 5],
    severity: 3,
    contagious: 0,
    cure: "herb",
    symptom: "a festering wound",
  }),
  plague: Object.freeze({
    label: "the pale plague",
    durationDays: [6, 8],
    severity: 4,
    contagious: 0.12,
    cure: "healer",
    symptom: "pale, sweating, and coughing blood",
  }),
});

const ILLNESS_KEYS = Object.freeze(Object.keys(ILLNESSES));

function illnessDef(key) {
  return ILLNESSES[String(key ?? "").toLowerCase()] ?? null;
}

// --- tuning ------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const WORK_PENALTY_PER_SEVERITY = 15; // severity 4 (plague) = -60: cannot work
const PLAGUE_MORTALITY_PER_TICK = 0.0008; // extra death chance while plagued
const EPIDEMIC_THRESHOLD = 3; // this many same-illness cases = epidemic
const HOSPITAL_BEDS = 6;
const HOSPITAL_RECOVERY_MULT = 2; // patients recover twice as fast

// --- state -------------------------------------------------------------------

let cache = null; // { sick: { [norm]: record }, hospitals: { [kingdomId]: record } }
let dirty = false;

function blankState() {
  return { sick: Object.create(null), hospitals: Object.create(null) };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        if (raw.sick && typeof raw.sick === "object") cache.sick = raw.sick;
        if (raw.hospitals && typeof raw.hospitals === "object") cache.hospitals = raw.hospitals;
      }
    }
  } catch {
    // Corrupt save — start clean rather than crash the tick.
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty || !cache) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    const tmp = SAVE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, SAVE_FILE);
    dirty = false;
    return true;
  } catch {
    // Best-effort: never break the tick over a save failure.
    return false;
  }
}

function markDirty() {
  dirty = true;
}

/** Test seam — drop the in-memory cache. */
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- illness records ---------------------------------------------------------

function recordOf(username) {
  const st = load();
  return st.sick[normalizeName(username)] ?? null;
}

function isSick(username) {
  return recordOf(username) !== null;
}

/**
 * Make a citizen sick. Returns the record, or null for unknown illness.
 * Re-sickening refreshes the record (a worse bout replaces a milder one).
 */
function sicken(username, illnessKey, nowMs, opts = {}) {
  const def = illnessDef(illnessKey);
  if (!def) return null;
  const st = load();
  const norm = normalizeName(username);
  const [dMin, dMax] = def.durationDays;
  const span = Math.max(1, dMax - dMin + 1);
  const days = dMin + Math.floor((opts.rng ? opts.rng() : Math.random()) * span);
  const existing = st.sick[norm];
  if (existing && illnessDef(existing.illness).severity >= def.severity) {
    return existing; // already suffering something at least as bad
  }
  const rec = {
    username: norm,
    display: opts.display ?? username,
    illness: illnessKey.toLowerCase(),
    severity: def.severity,
    startedAt: nowMs,
    recoverAt: nowMs + days * DAY_MS,
    treatedBy: null,
    inHospital: false,
    kingdomId: opts.kingdomId ?? null,
  };
  st.sick[norm] = rec;
  markDirty();
  return rec;
}

/** Cure a citizen (recovery, healer, or medicine). Returns true if they were sick. */
function cure(username, how = "recovered") {
  const st = load();
  const norm = normalizeName(username);
  if (!st.sick[norm]) return false;
  delete st.sick[norm];
  markDirty();
  return true;
}

/** Mark who treated the patient (journaled by the tick code). */
function setTreatedBy(username, healerName) {
  const st = load();
  const rec = st.sick[normalizeName(username)];
  if (!rec) return false;
  rec.treatedBy = healerName;
  // Treatment shortens the bout: shave a third off the remaining time.
  const now = Date.now();
  const remaining = Math.max(0, rec.recoverAt - now);
  rec.recoverAt = now + Math.floor(remaining * 0.66);
  markDirty();
  return true;
}

/** Work penalty 0..60 for the decision layer. Pure. */
function workPenaltyFor(username) {
  const rec = recordOf(username);
  if (!rec) return 0;
  return Math.min(60, rec.severity * WORK_PENALTY_PER_SEVERITY);
}

/**
 * Extra per-tick death chance, read by CitizenFunerals.mortalityChanceFor.
 * Only the plague kills; everything else just lays citizens low.
 */
function mortalityBonusFor(username) {
  const rec = recordOf(username);
  if (!rec || rec.illness !== "plague") return 0;
  return PLAGUE_MORTALITY_PER_TICK;
}

/** Human-readable summary for chat/LLM. Null when healthy. */
function sicknessSummary(username) {
  const rec = recordOf(username);
  if (!rec) return null;
  const def = illnessDef(rec.illness);
  return {
    illness: rec.illness,
    label: def.label,
    symptom: def.symptom,
    severity: rec.severity,
    inHospital: !!rec.inHospital,
    treatedBy: rec.treatedBy,
  };
}

/** All sick records in a kingdom (for healers, epidemics, hospitals). */
function sickOfKingdom(kingdomId) {
  const st = load();
  return Object.values(st.sick).filter((r) => r.kingdomId === kingdomId);
}

/** Count of citizens currently sick with a given illness in a kingdom. */
function casesOf(kingdomId, illnessKey) {
  return sickOfKingdom(kingdomId).filter((r) => r.illness === illnessKey).length;
}

/** True when an illness has reached epidemic levels in a kingdom. */
function isEpidemic(kingdomId, illnessKey) {
  return casesOf(kingdomId, illnessKey) >= EPIDEMIC_THRESHOLD;
}

// --- hospitals ---------------------------------------------------------------

function hospitalOfKingdom(kingdomId) {
  const st = load();
  return st.hospitals[kingdomId] ?? null;
}

function ensureHospital(kingdomId, name) {
  const st = load();
  if (!st.hospitals[kingdomId]) {
    st.hospitals[kingdomId] = {
      kingdomId,
      name: name ?? `${kingdomId} infirmary`,
      beds: HOSPITAL_BEDS,
      patients: [],
      healers: [],
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.hospitals[kingdomId];
}

function patientsOfKingdom(kingdomId) {
  const h = hospitalOfKingdom(kingdomId);
  return h ? h.patients.slice() : [];
}

/** Admit a sick citizen. Returns false when full or not sick. */
function admitPatient(username, kingdomId) {
  const st = load();
  const norm = normalizeName(username);
  const rec = st.sick[norm];
  if (!rec) return false;
  const hosp = ensureHospital(kingdomId);
  if (hosp.patients.length >= hosp.beds) return false;
  if (!hosp.patients.includes(norm)) hosp.patients.push(norm);
  rec.inHospital = true;
  // Hospital care doubles recovery speed: halve the remaining time.
  const now = Date.now();
  rec.recoverAt = Math.min(rec.recoverAt, now + Math.floor(Math.max(0, rec.recoverAt - now) / HOSPITAL_RECOVERY_MULT));
  markDirty();
  return true;
}

/** Discharge a patient (recovered or walking out). */
function dischargePatient(username) {
  const st = load();
  const norm = normalizeName(username);
  for (const hosp of Object.values(st.hospitals)) {
    const i = hosp.patients.indexOf(norm);
    if (i >= 0) hosp.patients.splice(i, 1);
  }
  const rec = st.sick[norm];
  if (rec) rec.inHospital = false;
  markDirty();
}

module.exports = {
  ILLNESSES,
  ILLNESS_KEYS,
  illnessDef,
  WORK_PENALTY_PER_SEVERITY,
  EPIDEMIC_THRESHOLD,
  HOSPITAL_BEDS,
  recordOf,
  isSick,
  sicken,
  cure,
  setTreatedBy,
  workPenaltyFor,
  mortalityBonusFor,
  sicknessSummary,
  sickOfKingdom,
  casesOf,
  isEpidemic,
  hospitalOfKingdom,
  ensureHospital,
  patientsOfKingdom,
  admitPatient,
  dischargePatient,
  save,
  load,
  resetForTests,
  _setSavePathForTests,
};
