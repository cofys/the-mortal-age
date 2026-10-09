"use strict";

/**
 * CitizenSurgery — the data tier for advanced citizen medicine.
 *
 * NO-OVERLAP BOUNDARY:
 *   CitizenHealth owns: illness records, the 5-illness catalog (cold, flu,
 *   food poisoning, wound infection, plague), natural recovery, healer
 *   visits, herb medicine, hospitals (6 beds), epidemics.
 *   THIS module owns: surgical procedures for cases beyond herb medicine,
 *   the surgeon profession (specialized healers), hospital surgery wings,
 *   medical research (new cures), and epidemic response (quarantine,
 *   mass treatment). It READS CitizenHealth records but never writes
 *   illness state directly — cures go through CitizenHealth.cure().
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   surgery catalog (procedures with skill/material requirements),
 *   surgeon registry (healer-career citizens with herblore 50+),
 *   procedure records {patient, procedure, surgeon, startedAt, status},
 *   hospital surgery wings per kingdom, medical research projects,
 *   quarantine zones, and pure helpers: needsSurgery, surgeonOf,
 *   successChanceFor, researchBonusFor.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Scheduling, progress, research, and quarantine
 *     live in lib/CitizenSurgeryLife.js (the director ticks that).
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - Surgery is honest: procedures consume REAL materials (thread,
 *     bandages, advanced potions) from real inventories. Material item
 *     ids are read from engine plugins at runtime, never hardcoded.
 *
 * DESIGN NOTES:
 *   - Surgery is for severity that herb medicine can't fix: deep wound
 *     infections, plague complications, broken bones. A surgeon is a
 *     healer who specialized — herblore 50+ unlocks the profession.
 *   - Research unlocks better procedures over time: the first surgeons
 *     can stitch wounds; researched surgeons can purge plague.
 *   - Quarantine is the epidemic answer: sick citizens isolated in the
 *     hospital wing recover without spreading contagion.
 *
 * Persisted to data/saves/citizen-surgery.json (dirty-flag pattern, never
 * committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-surgery.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- surgery catalog ---------------------------------------------------------
// skillReq: herblore level the surgeon needs.
// materials: { itemKey: count } — resolved to real item ids at use time.
// durationHours: real-time procedure length.
// successBase: base success chance (0..1), modified by surgeon skill and
//   research. Failure = the illness persists, materials are consumed anyway.

const PROCEDURES = Object.freeze({
  stitch_wound: Object.freeze({
    label: "stitching a festering wound",
    skillReq: 50,
    materials: Object.freeze({ thread: 1, bandage: 2 }),
    durationHours: 2,
    successBase: 0.85,
    cures: Object.freeze(["infection"]),
    researchReq: null, // available from the start
  }),
  set_bone: Object.freeze({
    label: "setting a broken bone",
    skillReq: 55,
    materials: Object.freeze({ bandage: 3, splint: 1 }),
    durationHours: 3,
    successBase: 0.8,
    cures: Object.freeze(["fracture"]),
    researchReq: null,
  }),
  purge_plague: Object.freeze({
    label: "purging the pale plague",
    skillReq: 65,
    materials: Object.freeze({ super_restore: 1, bandage: 2 }),
    durationHours: 6,
    successBase: 0.7,
    cures: Object.freeze(["plague"]),
    researchReq: "plague_antidote",
  }),
  remove_growth: Object.freeze({
    label: "removing a dangerous growth",
    skillReq: 75,
    materials: Object.freeze({ super_restore: 2, thread: 2, bandage: 3 }),
    durationHours: 8,
    successBase: 0.6,
    cures: Object.freeze(["growth"]),
    researchReq: "advanced_anatomy",
  }),
});

const PROCEDURE_KEYS = Object.freeze(Object.keys(PROCEDURES));

function procedureDef(key) {
  return PROCEDURES[key] ?? null;
}

// --- medical research --------------------------------------------------------
// Research unlocks advanced procedures. Each project needs a surgeon with
// the skill, real materials invested, and real time. Completion is
// kingdom-wide: once researched, every surgeon in the kingdom can use it.

const RESEARCH = Object.freeze({
  plague_antidote: Object.freeze({
    label: "plague antidote",
    skillReq: 60,
    materials: Object.freeze({ clean_herb: 10, super_restore: 2 }),
    durationHours: 48,
    unlocks: "purge_plague",
  }),
  advanced_anatomy: Object.freeze({
    label: "advanced anatomy",
    skillReq: 70,
    materials: Object.freeze({ clean_herb: 15, paper: 5 }),
    durationHours: 72,
    unlocks: "remove_growth",
  }),
  field_medicine: Object.freeze({
    label: "field medicine",
    skillReq: 55,
    materials: Object.freeze({ clean_herb: 8, bandage: 10 }),
    durationHours: 36,
    unlocks: null, // passive: +10% surgery success kingdom-wide
  }),
});

const RESEARCH_KEYS = Object.freeze(Object.keys(RESEARCH));

function researchDef(key) {
  return RESEARCH[key] ?? null;
}

// --- tuning ------------------------------------------------------------------

const SURGEON_SKILL_REQ = 50; // herblore level to become a surgeon
const SURGERY_WING_BEDS = 4; // surgery wing beds per kingdom
const QUARANTINE_BEDS = 8; // quarantine capacity per kingdom
const RESEARCH_SUCCESS_BONUS = 0.1; // field_medicine bonus

// --- material item resolution --------------------------------------------------
// Item ids are read from engine plugins at runtime, never hardcoded.
// Falls back to null (procedure cannot start without materials).

let _materialCache = null;

function materialIds() {
  if (_materialCache) return _materialCache;
  const ids = {};
  try {
    // Thread and bandages: read from the crafting/economy item tables.
    // These are best-effort defensive reads — missing tables mean the
    // procedure honestly cannot be performed.
    const Items = require("../../items/Items.plugin.js");
    ids.thread = Items.itemIdByName?.("thread") ?? null;
    ids.bandage = Items.itemIdByName?.("bandage") ?? null;
    ids.splint = Items.itemIdByName?.("splint") ?? null;
    ids.paper = Items.itemIdByName?.("paper") ?? null;
  } catch {
    // Engine items plugin unavailable — materials unresolvable.
  }
  try {
    const Herblore = require("../../skills/Herblore.plugin.js");
    ids.clean_herb = Herblore.cleanHerbId?.() ?? null;
    ids.super_restore = Herblore.potionIdByName?.("super restore") ?? null;
  } catch {
    // Herblore plugin unavailable — potion materials unresolvable.
  }
  _materialCache = Object.freeze(ids);
  return _materialCache;
}

/** Test seam — inject material ids without the engine. */
function _setMaterialIdsForTests(ids) {
  _materialCache = Object.freeze({ ...ids });
}

// --- state -------------------------------------------------------------------

function blankState() {
  return {
    procedures: Object.create(null), // [normName] -> { procedure, surgeon, startedAt, status }
    surgeons: Object.create(null), // [normName] -> { since }
    wings: Object.create(null), // [kingdomId] -> { beds, built }
    research: Object.create(null), // [kingdomId] -> { [researchKey]: { status, startedAt, by } }
    quarantine: Object.create(null), // [kingdomId] -> { patients: [normName], since }
  };
}

let cache = null;
let dirty = false;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = { ...blankState(), ...parsed };
  } catch {
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
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
  _materialCache = null;
}

// --- surgeon registry ----------------------------------------------------------

function isSurgeon(username) {
  const st = load();
  return !!st.surgeons[normalizeName(username)];
}

function registerSurgeon(username, nowMs) {
  const st = load();
  const key = normalizeName(username);
  if (!st.surgeons[key]) {
    st.surgeons[key] = { since: nowMs };
    markDirty();
  }
}

function surgeonsOfKingdom(kingdomId, roster) {
  // roster: iterable of citizen records with kingdomId. Defensive.
  const out = [];
  try {
    for (const rec of roster ?? []) {
      if (!rec) continue;
      const kid = rec.kingdomId ?? rec.kingdom_id;
      if (kid !== kingdomId) continue;
      const name = rec.username ?? rec.name;
      if (name && isSurgeon(name)) out.push(rec);
    }
  } catch {
    // Never throw from a data-tier helper.
  }
  return out;
}

// --- surgery wing ----------------------------------------------------------------
// Each kingdom can build a surgery wing (4 beds). Procedures need a wing.

function wingOf(kingdomId) {
  const st = load();
  return st.wings[kingdomId] ?? null;
}

function buildWing(kingdomId, nowMs) {
  const st = load();
  if (!st.wings[kingdomId]) {
    st.wings[kingdomId] = { beds: SURGERY_WING_BEDS, built: nowMs };
    markDirty();
    return true;
  }
  return false;
}

function wingPatients(kingdomId) {
  const st = load();
  return Object.entries(st.procedures)
    .filter(([, p]) => p.kingdomId === kingdomId && p.status === "in_progress")
    .map(([name]) => name);
}

// --- procedure records -----------------------------------------------------------

/**
 * Does this citizen need surgery? True when they have an illness that a
 * procedure cures AND (severity >= 3 OR the illness has resisted herb
 * treatment). Pure read of CitizenHealth — never writes illness state.
 */
function needsSurgery(username) {
  try {
    const Health = require("./CitizenHealth");
    const rec = Health.recordOf(username);
    if (!rec) return null;
    const def = Health.illnessDef(rec.illness);
    if (!def) return null;
    // Find a procedure that cures this illness.
    for (const key of PROCEDURE_KEYS) {
      const proc = PROCEDURES[key];
      if (proc.cures.includes(rec.illness)) {
        // Severe cases always qualify; others qualify if already treated
        // once without success (the healer tried and it didn't take).
        if (def.severity >= 3 || rec.treatedBy) {
          return { procedure: key, illness: rec.illness, severity: def.severity };
        }
      }
    }
  } catch {
    // CitizenHealth unavailable — no surgery needed.
  }
  return null;
}

function procedureOf(username) {
  const st = load();
  return st.procedures[normalizeName(username)] ?? null;
}

function scheduleProcedure(username, procedureKey, surgeonName, kingdomId, nowMs) {
  const st = load();
  const proc = procedureDef(procedureKey);
  if (!proc) return false;
  const key = normalizeName(username);
  if (st.procedures[key]?.status === "in_progress") return false; // already scheduled
  st.procedures[key] = {
    procedure: procedureKey,
    surgeon: normalizeName(surgeonName),
    kingdomId,
    startedAt: nowMs,
    status: "in_progress",
  };
  markDirty();
  return true;
}

function completeProcedure(username, success, nowMs) {
  const st = load();
  const key = normalizeName(username);
  const rec = st.procedures[key];
  if (!rec || rec.status !== "in_progress") return false;
  rec.status = success ? "completed" : "failed";
  rec.completedAt = nowMs;
  markDirty();
  // On success, cure through the real health system — never bypass it.
  if (success) {
    try {
      const Health = require("./CitizenHealth");
      Health.cure(username, "surgery");
    } catch {
      // Health system unavailable — record the success anyway.
    }
  }
  return true;
}

/**
 * Success chance for a procedure: base + surgeon skill bonus + research
 * bonus. Pure. surgeonLevel: the surgeon's herblore level.
 */
function successChanceFor(procedureKey, surgeonLevel, kingdomId) {
  const proc = procedureDef(procedureKey);
  if (!proc) return 0;
  let chance = proc.successBase;
  // Skill bonus: +0.5% per level above requirement, capped at +15%.
  const over = Math.max(0, (surgeonLevel ?? 0) - proc.skillReq);
  chance += Math.min(0.15, over * 0.005);
  // Research bonus: field_medicine gives +10% kingdom-wide.
  if (researchDone(kingdomId, "field_medicine")) {
    chance += RESEARCH_SUCCESS_BONUS;
  }
  return Math.min(0.95, chance);
}

// --- medical research ------------------------------------------------------------

function researchStatus(kingdomId, researchKey) {
  const st = load();
  return st.research[kingdomId]?.[researchKey]?.status ?? "not_started";
}

function researchDone(kingdomId, researchKey) {
  return researchStatus(kingdomId, researchKey) === "completed";
}

function startResearch(kingdomId, researchKey, byName, nowMs) {
  const st = load();
  const def = researchDef(researchKey);
  if (!def) return false;
  st.research[kingdomId] = st.research[kingdomId] ?? {};
  const existing = st.research[kingdomId][researchKey];
  if (existing && existing.status !== "not_started") return false;
  st.research[kingdomId][researchKey] = {
    status: "in_progress",
    startedAt: nowMs,
    by: normalizeName(byName),
  };
  markDirty();
  return true;
}

function completeResearch(kingdomId, researchKey, nowMs) {
  const st = load();
  const rec = st.research[kingdomId]?.[researchKey];
  if (!rec || rec.status !== "in_progress") return false;
  rec.status = "completed";
  rec.completedAt = nowMs;
  markDirty();
  return true;
}

function researchProgress(kingdomId, researchKey, nowMs) {
  const st = load();
  const rec = st.research[kingdomId]?.[researchKey];
  const def = researchDef(researchKey);
  if (!rec || !def || rec.status !== "in_progress") return 0;
  const elapsed = nowMs - rec.startedAt;
  // Science boost: medicine discoveries accelerate medical research.
  let boost = 1;
  try {
    const Science = require("./CitizenScience");
    boost = 1 + (Science.surgeryResearchBonusFor(kingdomId) ?? 0);
  } catch { /* science module missing — no boost */ }
  const total = (def.durationHours * 3600 * 1000) / boost;
  return Math.min(1, elapsed / total);
}

/** Is this procedure unlocked in this kingdom? (Research-gated ones need it.) */
function procedureUnlocked(kingdomId, procedureKey) {
  const proc = procedureDef(procedureKey);
  if (!proc) return false;
  if (!proc.researchReq) return true;
  return researchDone(kingdomId, proc.researchReq);
}

// --- quarantine ------------------------------------------------------------------
// During epidemics, sick citizens can be quarantined: they recover in
// isolation without spreading contagion. Quarantine reads CitizenHealth
// records but the isolation flag lives here.

function quarantineOf(kingdomId) {
  const st = load();
  const q = st.quarantine[kingdomId];
  return q ? [...q.patients] : [];
}

function isQuarantined(username) {
  const st = load();
  const key = normalizeName(username);
  return Object.values(st.quarantine).some((q) => q.patients.includes(key));
}

function quarantinePatient(username, kingdomId, nowMs) {
  const st = load();
  const key = normalizeName(username);
  st.quarantine[kingdomId] = st.quarantine[kingdomId] ?? { patients: [], since: nowMs };
  const q = st.quarantine[kingdomId];
  if (q.patients.length >= QUARANTINE_BEDS) return false; // full
  if (q.patients.includes(key)) return false; // already there
  q.patients.push(key);
  markDirty();
  return true;
}

function releaseFromQuarantine(username, kingdomId) {
  const st = load();
  const key = normalizeName(username);
  const q = st.quarantine[kingdomId];
  if (!q) return false;
  const idx = q.patients.indexOf(key);
  if (idx < 0) return false;
  q.patients.splice(idx, 1);
  markDirty();
  return true;
}

// --- player patients ---------------------------------------------------------------
// Real players can request surgery from a citizen surgeon. The procedure
// record tracks them the same way; the Life tick resolves it.

function requestSurgeryForPlayer(playerName, procedureKey, kingdomId, nowMs) {
  // Players go through the same scheduling path — no special cases.
  // The surgeon is assigned by the Life tick from available surgeons.
  const st = load();
  const key = normalizeName(playerName);
  if (st.procedures[key]?.status === "in_progress") return false;
  st.procedures[key] = {
    procedure: procedureKey,
    surgeon: null, // assigned by the tick
    kingdomId,
    startedAt: nowMs,
    status: "queued",
    isPlayer: true,
  };
  markDirty();
  return true;
}

module.exports = {
  // catalog
  PROCEDURES,
  PROCEDURE_KEYS,
  procedureDef,
  RESEARCH,
  RESEARCH_KEYS,
  researchDef,
  // tuning
  SURGEON_SKILL_REQ,
  SURGERY_WING_BEDS,
  QUARANTINE_BEDS,
  // materials
  materialIds,
  _setMaterialIdsForTests,
  // surgeons
  isSurgeon,
  registerSurgeon,
  surgeonsOfKingdom,
  // wings
  wingOf,
  buildWing,
  wingPatients,
  // procedures
  needsSurgery,
  procedureOf,
  scheduleProcedure,
  completeProcedure,
  successChanceFor,
  procedureUnlocked,
  // research
  researchStatus,
  researchDone,
  startResearch,
  completeResearch,
  researchProgress,
  // quarantine
  quarantineOf,
  isQuarantined,
  quarantinePatient,
  releaseFromQuarantine,
  // players
  requestSurgeryForPlayer,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
};
