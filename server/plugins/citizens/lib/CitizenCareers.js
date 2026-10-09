"use strict";

/**
 * CitizenCareers — the data layer for citizen jobs and careers.
 *
 * Every citizen has a CAREER: the trade they practice day to day. This is
 * distinct from `role` (social standing: commoner, merchant, guard, courtier)
 * and `goal` (short-term aim). A career is persistent state: what you do,
 * how good you are at it, and what you've done before.
 *
 * Ranks: apprentice → journeyman → master.
 *   - Skill-mapped careers (woodcutter, fisher, miner, cook): rank from the
 *     citizen's REAL skill level in CitizenSkilling's skillStore.
 *   - Other careers (smith, crafter, trader, guard, laborer, barkeep,
 *     scribe, farmer): rank from tenure — days practicing the career.
 *     (Smithing/crafting XP flows through the engine SkillManager for
 *     foreground citizens but isn't in the citizen skillStore yet.)
 *
 * Income:
 *   - Service careers (guard, laborer, barkeep, scribe) earn a daily WAGE
 *     in real coins: online citizens get coins in their real inventory,
 *     offline citizens accrue savings paid out when they materialize.
 *   - Trade careers (smith, cook, crafter, trader, fisher, miner,
 *     woodcutter, farmer) earn by selling what they make — no wage, their
 *     income is the real market. (The wage would double-count.)
 *
 * Career changes: citizens switch careers when their goal shifts, when
 * they're broke in a low-paying career, or when personality drives them
 * (ambitious citizens chase mastery; restless ones drift). History is kept
 * so the LLM mouth can answer "what did you do before?" truthfully.
 *
 * Teaching: masters of a career may take apprentices — the pairing pattern
 * follows lib/CitizenApprentices.js (master 60+ / apprentice <25 in the
 * trade skill). CareerLife wires career-aware teaching on the slow tick.
 *
 * This is the DATA tier: pure state, zero LLM, tick-safe. The dynamics
 * (assignment, promotions, wages, changes, teaching) live in
 * lib/CitizenCareerLife.js, which the director ticks.
 *
 * Persisted to data/saves/citizen-careers.json (never committed).
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-careers.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- ranks -------------------------------------------------------------------

const RANK_APPRENTICE = "apprentice";
const RANK_JOURNEYMAN = "journeyman";
const RANK_MASTER = "master";

const RANKS = Object.freeze([RANK_APPRENTICE, RANK_JOURNEYMAN, RANK_MASTER]);

const RANK_LABELS = Object.freeze({
  [RANK_APPRENTICE]: "apprentice",
  [RANK_JOURNEYMAN]: "journeyman",
  [RANK_MASTER]: "master",
});

// Skill-mapped careers promote on real skill level; everyone else on tenure.
const SKILL_RANK_LEVELS = Object.freeze({
  [RANK_APPRENTICE]: 1,
  [RANK_JOURNEYMAN]: 30,
  [RANK_MASTER]: 60,
});

const DAY_MS = 24 * 3600 * 1000;
const TENURE_RANK_DAYS = Object.freeze({
  [RANK_APPRENTICE]: 0,
  [RANK_JOURNEYMAN]: 7,
  [RANK_MASTER]: 30,
});

// --- career catalog ----------------------------------------------------------
// skill: CitizenSkilling skill id, or null for tenure-ranked careers.
// wage: daily wage in coins for SERVICE careers; 0 for trade careers (they
//   earn by selling goods — a wage would double-count their income).
// service: true if this career earns a wage rather than trade income.

const CAREERS = Object.freeze({
  woodcutter: Object.freeze({ label: "woodcutter", skill: "woodcutting", wage: 0, service: false }),
  fisher: Object.freeze({ label: "fisher", skill: "fishing", wage: 0, service: false }),
  miner: Object.freeze({ label: "miner", skill: "mining", wage: 0, service: false }),
  smith: Object.freeze({ label: "blacksmith", skill: null, wage: 0, service: false }),
  cook: Object.freeze({ label: "cook", skill: "cooking", wage: 0, service: false }),
  crafter: Object.freeze({ label: "crafter", skill: null, wage: 0, service: false }),
  farmer: Object.freeze({ label: "farmer", skill: null, wage: 0, service: false }),
  trader: Object.freeze({ label: "trader", skill: null, wage: 0, service: false }),
  guard: Object.freeze({ label: "guard", skill: null, wage: 300, service: true }),
  laborer: Object.freeze({ label: "laborer", skill: null, wage: 120, service: true }),
  barkeep: Object.freeze({ label: "barkeep", skill: null, wage: 150, service: true }),
  scribe: Object.freeze({ label: "scribe", skill: null, wage: 180, service: true }),
});

const CAREER_KEYS = Object.freeze(Object.keys(CAREERS));

const WAGE_RANK_MULT = Object.freeze({
  [RANK_APPRENTICE]: 0.6,
  [RANK_JOURNEYMAN]: 1.0,
  [RANK_MASTER]: 1.6,
});

function careerDef(key) {
  return CAREERS[String(key ?? "").toLowerCase()] ?? null;
}

// --- storage -----------------------------------------------------------------

const MAX_HISTORY = 8;

let cache = null;
let dirty = false;

function data() {
  if (!cache) cache = load();
  return cache;
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return { careers: {} };
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return { careers: {} };
    if (!raw.careers || typeof raw.careers !== "object") raw.careers = {};
    return raw;
  } catch {
    return { careers: {} };
  }
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

/** Test seam — wipe in-memory state (nulls cache so next read reloads from disk). */
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- records -----------------------------------------------------------------

function blankCareer(careerKey, nowMs) {
  return {
    career: careerKey,
    rank: RANK_APPRENTICE,
    since: nowMs ?? Date.now(),
    rankSince: nowMs ?? Date.now(),
    history: [],
    lastWageAt: 0,
    savings: 0, // wages banked while offline; paid out on materialize
  };
}

/** Get (or create) the career record for a citizen. Null for bad names. */
function careerFor(citizenName, nowMs) {
  const key = normalizeName(citizenName);
  if (!key) return null;
  const d = data();
  if (!d.careers[key]) {
    d.careers[key] = blankCareer("laborer", nowMs);
    markDirty();
  }
  return d.careers[key];
}

/** Set a citizen's career, archiving the old one into history. */
function setCareer(citizenName, careerKey, nowMs) {
  const def = careerDef(careerKey);
  if (!def) return null;
  const rec = careerFor(citizenName, nowMs);
  if (!rec) return null;
  const now = nowMs ?? Date.now();
  const norm = String(careerKey).toLowerCase();
  if (rec.career === norm) return rec; // no-op
  rec.history.push({
    career: rec.career,
    rank: rec.rank,
    from: rec.since,
    to: now,
  });
  if (rec.history.length > MAX_HISTORY) rec.history.splice(0, rec.history.length - MAX_HISTORY);
  rec.career = norm;
  rec.rank = RANK_APPRENTICE; // new trade, start at the bottom
  rec.since = now;
  rec.rankSince = now;
  markDirty();
  journalCareer(citizenName, `took up ${def.label} work`);
  return rec;
}

/** Promote a citizen to a rank (used by the life tick after rank checks). */
function setRank(citizenName, rank, nowMs) {
  if (!RANKS.includes(rank)) return null;
  const rec = careerFor(citizenName, nowMs);
  if (!rec) return null;
  if (rec.rank === rank) return rec;
  rec.rank = rank;
  rec.rankSince = nowMs ?? Date.now();
  markDirty();
  const def = careerDef(rec.career);
  journalCareer(citizenName, `rose to ${rank} ${def ? def.label : rec.career}`);
  return rec;
}

function journalCareer(citizenName, text) {
  try {
    getJournal().log(citizenName, "career", text);
  } catch {
    // Non-fatal.
  }
}

// --- rank computation ----------------------------------------------------------

/**
 * Compute the rank a citizen has EARNED in their career.
 * Skill-mapped careers read the real skill level from the provided getter;
 * tenure careers read days since the career started.
 * getSkillLevel(name, skillId) -> level number (or null/undefined).
 */
function earnedRank(careerKey, record, getSkillLevel) {
  const def = careerDef(careerKey);
  if (!def) return RANK_APPRENTICE;
  if (def.skill && typeof getSkillLevel === "function") {
    let level = null;
    try {
      level = getSkillLevel(record?.username ?? record?.name, def.skill);
    } catch {
      level = null;
    }
    const lvl = Number(level);
    if (!Number.isFinite(lvl) || lvl < 1) return RANK_APPRENTICE;
    if (lvl >= SKILL_RANK_LEVELS[RANK_MASTER]) return RANK_MASTER;
    if (lvl >= SKILL_RANK_LEVELS[RANK_JOURNEYMAN]) return RANK_JOURNEYMAN;
    return RANK_APPRENTICE;
  }
  // Tenure-ranked.
  const since = Number(record?.since ?? Date.now());
  const days = Math.max(0, (Date.now() - since) / DAY_MS);
  if (days >= TENURE_RANK_DAYS[RANK_MASTER]) return RANK_MASTER;
  if (days >= TENURE_RANK_DAYS[RANK_JOURNEYMAN]) return RANK_JOURNEYMAN;
  return RANK_APPRENTICE;
}

/** Daily wage for a career+rank. 0 for trade careers (they sell goods). */
function dailyWage(careerKey, rank) {
  const def = careerDef(careerKey);
  if (!def || !def.service) return 0;
  const mult = WAGE_RANK_MULT[rank] ?? 1;
  return Math.floor(def.wage * mult);
}

/** Raw record lookup without auto-creating (null when the citizen has no career yet). */
function careerOf(citizenName) {
  const key = normalizeName(citizenName);
  if (!key) return null;
  return data().careers[key] ?? null;
}

/** Human-readable "Master blacksmith" / "apprentice cook" style title. */
function titleFor(citizenName) {
  const rec = careerOf(citizenName);
  if (!rec) return "laborer";
  const def = careerDef(rec.career);
  const label = def ? def.label : rec.career;
  if (rec.rank === RANK_MASTER) return `Master ${label}`;
  return `${rec.rank} ${label}`;
}

/** One-line career summary for chat/LLM. */
function describeCareer(citizenName) {
  const rec = careerOf(citizenName);
  if (!rec) return "between jobs at the moment";
  const def = careerDef(rec.career);
  const label = def ? def.label : rec.career;
  let s = `${rec.rank} ${label}`;
  if (rec.history.length > 0) {
    const prev = rec.history[rec.history.length - 1];
    const pdef = careerDef(prev.career);
    s += ` (used to be a ${pdef ? pdef.label : prev.career})`;
  }
  return s;
}

module.exports = {
  CAREERS,
  CAREER_KEYS,
  RANKS,
  RANK_APPRENTICE,
  RANK_JOURNEYMAN,
  RANK_MASTER,
  careerDef,
  careerFor,
  careerOf,
  setCareer,
  setRank,
  earnedRank,
  dailyWage,
  titleFor,
  describeCareer,
  save,
  resetForTests,
  _setSavePathForTests,
  _data: data,
};
