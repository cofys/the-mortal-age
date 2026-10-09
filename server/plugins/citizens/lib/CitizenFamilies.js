"use strict";

/**
 * CitizenFamilies — the data layer for citizen families and children.
 *
 * Marriage already exists (CitizenKinship: courting → serious → married).
 * This module is what comes AFTER the wedding: families form around married
 * couples, children are born, grow up (baby → child → teen → adult), learn
 * from their parents, and eventually join the town as citizens themselves.
 *
 * This is the DATA tier: pure state, zero LLM, tick-safe. The dynamics
 * (births, aging, coming-of-age, inheritance, teaching, protection) live in
 * lib/CitizenFamilyLife.js, which the director ticks. The foreground (chat,
 * LLM) reads this and roleplays from it — "my daughter Mara" is a real
 * record, not a generated line.
 *
 * Design notes (all state is real, nothing hash-derived):
 *   - Children are DATA records, not roster citizens, until adulthood.
 *     A child has no Player object, no inventory, no skills — just a birth
 *     record, a growth stage, inherited traits, and lessons learned. When a
 *     child comes of age they become eligible to join the roster through
 *     the same door every citizen uses (FamilyLife builds the record).
 *   - Growth is compressed real-time: baby (0–7d), child (7–21d), teen
 *     (21–35d), adult (35d+). A family started today has grown children in
 *     about five weeks — fast enough to matter, slow enough to feel real.
 *   - Surnames are inherited: children take the family surname. Spouses
 *     keep their own names at marriage (kinship's choice); the family
 *     record picks the shared surname when both match, else spouse A's.
 *   - Bequests (inheritance coins) accrue on the child/family record and
 *     flush to the real inventory when the heir materializes — the same
 *     savings pattern CitizenCareerLife uses for offline wages.
 *
 * Persisted to data/saves/citizen-families.json (never committed). Bounded:
 * children per family, activity log length, and total families are capped.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-families.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// === Tuning: all magic numbers here ===
const DAY_MS = 24 * 3600 * 1000;
const STAGE_BABY = "baby";
const STAGE_CHILD = "child";
const STAGE_TEEN = "teen";
const STAGE_ADULT = "adult";
const STAGES = Object.freeze([STAGE_BABY, STAGE_CHILD, STAGE_TEEN, STAGE_ADULT]);
// Compressed childhood: birth to adulthood in ~5 weeks.
const BABY_DAYS = 7;
const CHILD_DAYS = 21; // baby -> child at 7d, child -> teen at 21d
const TEEN_DAYS = 35; // teen -> adult at 35d
const MAX_CHILDREN_PER_FAMILY = 4;
const MAX_ACTIVITY_LOG = 30;
const MAX_FAMILIES = 400; // bound the save file

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "family", text);
  } catch {
    // Never break the tick.
  }
}

// === State ===
let loaded = false;
let dirty = false;
const families = new Map(); // familyId -> family record
const children = new Map(); // childId -> child record
let familySeq = 0;
let childSeq = 0;

function markDirty() {
  dirty = true;
}

function toJSON() {
  return {
    savedAt: Date.now(),
    familySeq,
    childSeq,
    families: [...families.values()],
    children: [...children.values()],
  };
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    familySeq = Number(parsed?.familySeq ?? 0);
    childSeq = Number(parsed?.childSeq ?? 0);
    for (const f of parsed?.families ?? []) {
      if (f?.id) families.set(f.id, f);
    }
    for (const c of parsed?.children ?? []) {
      if (c?.id) children.set(c.id, c);
    }
  } catch {
    // No save yet — start fresh.
  }
}

function save() {
  load();
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(toJSON()));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  families.clear();
  children.clear();
  familySeq = 0;
  childSeq = 0;
  loaded = false; // next access reloads from the (possibly redirected) save path
  dirty = false;
}

// === Helpers ===

function surnameOf(displayName) {
  const parts = String(displayName ?? "").trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function firstNameOf(displayName) {
  return String(displayName ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Growth stage for a child of the given age in ms. Pure function. */
function stageForAge(ageMs) {
  const days = ageMs / DAY_MS;
  if (days < BABY_DAYS) return STAGE_BABY;
  if (days < CHILD_DAYS) return STAGE_CHILD;
  if (days < TEEN_DAYS) return STAGE_TEEN;
  return STAGE_ADULT;
}

function isMinorStage(stage) {
  return stage !== STAGE_ADULT;
}

function blankFamily(id, spouseA, spouseADisplay, spouseB, spouseBDisplay, kingdomId) {
  const surnameA = surnameOf(spouseADisplay);
  const surnameB = surnameOf(spouseBDisplay);
  const surname = surnameA && surnameA === surnameB ? surnameA : surnameA || surnameB || "Citizen";
  return {
    id,
    surname,
    kingdomId,
    spouses: [normalizeName(spouseA), normalizeName(spouseB)],
    spouseDisplay: {
      [normalizeName(spouseA)]: spouseADisplay ?? spouseA,
      [normalizeName(spouseB)]: spouseBDisplay ?? spouseB,
    },
    children: [], // child record IDs, birth order
    homeId: null, // CitizenHomes id of the family home
    foundedAt: Date.now(),
    lastBirthAt: 0,
    activityLog: [],
  };
}

function blankChild(id, firstName, surname, parentA, parentB, familyId, kingdomId, traits, bornAt) {
  const display = `${firstName} ${surname}`;
  return {
    id,
    firstName,
    display,
    surname,
    parents: [normalizeName(parentA), normalizeName(parentB)],
    familyId,
    kingdomId,
    bornAt: bornAt ?? Date.now(),
    stage: STAGE_BABY,
    traits: Array.isArray(traits) ? traits.slice(0, 6) : [],
    bequest: 0, // coins owed — flushes to inventory on materialize
    joinedRoster: false,
    learnedXp: {}, // skillId -> xp taught by parents (converts on roster join)
    leftTown: false, // adult with no roster space may leave to seek fortune
  };
}

function logFamilyActivity(family, text) {
  if (!family) return;
  family.activityLog.push({ at: Date.now(), text });
  if (family.activityLog.length > MAX_ACTIVITY_LOG) {
    family.activityLog.splice(0, family.activityLog.length - MAX_ACTIVITY_LOG);
  }
  markDirty();
}

// === Public API ===

/**
 * Find the family a citizen belongs to (as a spouse). Null when familyless.
 */
function familyOf(citizenName) {
  load();
  const key = normalizeName(citizenName);
  for (const f of families.values()) {
    if (f.spouses.includes(key)) return f;
  }
  return null;
}

/**
 * Find the family a child belongs to. Null when unknown.
 */
function familyOfChild(childId) {
  load();
  const c = children.get(childId);
  return c ? families.get(c.familyId) ?? null : null;
}

/** All child records for a citizen (as a parent). Birth order. */
function childrenOf(citizenName) {
  load();
  const key = normalizeName(citizenName);
  const out = [];
  for (const c of children.values()) {
    if (c.parents.includes(key)) out.push(c);
  }
  out.sort((a, b) => a.bornAt - b.bornAt);
  return out;
}

/** Minor (non-adult) children of a citizen. */
function minorChildrenOf(citizenName) {
  return childrenOf(citizenName).filter((c) => isMinorStage(c.stage) && !c.leftTown);
}

/** Adult children of a citizen who have not left town. */
function adultChildrenOf(citizenName) {
  return childrenOf(citizenName).filter(
    (c) => c.stage === STAGE_ADULT && !c.leftTown
  );
}

function getChild(childId) {
  load();
  return children.get(childId) ?? null;
}

function allChildren() {
  load();
  return [...children.values()];
}

function allFamilies() {
  load();
  return [...families.values()];
}

/**
 * Create a family for a married couple. Idempotent — returns the existing
 * family when the couple already has one.
 */
function createFamily(spouseA, spouseADisplay, spouseB, spouseBDisplay, kingdomId) {
  load();
  const keyA = normalizeName(spouseA);
  const keyB = normalizeName(spouseB);
  if (!keyA || !keyB || keyA === keyB) return null;
  const existing = familyOf(spouseA);
  if (existing && existing.spouses.includes(keyB)) return existing;
  if (families.size >= MAX_FAMILIES) return null;
  familySeq += 1;
  const id = `fam_${familySeq}`;
  const family = blankFamily(id, spouseA, spouseADisplay, spouseB, spouseBDisplay, kingdomId);
  families.set(id, family);
  markDirty();
  logFamilyActivity(family, `${spouseADisplay ?? spouseA} and ${spouseBDisplay ?? spouseB} founded a family.`);
  return family;
}

/**
 * Record a birth into a family. Returns the child record, or null when the
 * family is at its child cap.
 */
function recordBirth(familyId, firstName, traits, bornAt) {
  load();
  const family = families.get(familyId);
  if (!family) return null;
  if (family.children.length >= MAX_CHILDREN_PER_FAMILY) return null;
  childSeq += 1;
  const id = `child_${childSeq}`;
  const child = blankChild(
    id,
    firstName,
    family.surname,
    family.spouses[0],
    family.spouses[1],
    familyId,
    family.kingdomId,
    traits,
    bornAt
  );
  children.set(id, child);
  family.children.push(id);
  family.lastBirthAt = child.bornAt;
  markDirty();
  logFamilyActivity(family, `${child.display} was born.`);
  return child;
}

/** Recompute a child's stage from its age. Returns true when it changed. */
function refreshStage(child, nowMs = Date.now()) {
  const next = stageForAge(nowMs - child.bornAt);
  if (next !== child.stage) {
    child.stage = next;
    markDirty();
    return true;
  }
  return false;
}

/** Add a coin bequest to a child (inheritance savings). */
function addBequest(childId, amount) {
  load();
  const child = children.get(childId);
  if (!child || amount <= 0) return 0;
  child.bequest = (child.bequest ?? 0) + Math.floor(amount);
  markDirty();
  return child.bequest;
}

/** Add taught XP to a minor child (converts to real XP on roster join). */
function addLearnedXp(childId, skillId, amount) {
  load();
  const child = children.get(childId);
  if (!child || !skillId || amount <= 0) return 0;
  child.learnedXp[skillId] = (child.learnedXp[skillId] ?? 0) + Math.floor(amount);
  markDirty();
  return child.learnedXp[skillId];
}

/** Mark a child as having joined the roster (they're a citizen now). */
function markJoinedRoster(childId) {
  load();
  const child = children.get(childId);
  if (!child) return false;
  child.joinedRoster = true;
  markDirty();
  return true;
}

/** Mark an adult child as having left town (no roster space). */
function markLeftTown(childId) {
  load();
  const child = children.get(childId);
  if (!child) return false;
  child.leftTown = true;
  markDirty();
  return true;
}

/**
 * Widow/orphan bookkeeping when a spouse is permanently gone: the family
 * record keeps the surviving spouse (and children); the deceased is dropped
 * from the spouses list but remembered in the activity log.
 */
function recordSpouseGone(familyId, deceasedName, deceasedDisplay) {
  load();
  const family = families.get(familyId);
  if (!family) return null;
  const key = normalizeName(deceasedName);
  const idx = family.spouses.indexOf(key);
  if (idx >= 0) family.spouses.splice(idx, 1);
  delete family.spouseDisplay[key];
  markDirty();
  logFamilyActivity(
    family,
    `${deceasedDisplay ?? deceasedName} is gone. The family mourns.`
  );
  return family;
}

/**
 * One-line family summary for the LLM chat context (token-lean).
 * "Married to X. Children: Mara (child), Tom (teen)."
 */
function familySummary(name) {
  load();
  const kids = childrenOf(name);
  if (kids.length === 0) return null;
  const parts = kids
    .filter((c) => !c.leftTown)
    .map((c) => `${c.firstName} (${c.stage})`);
  if (parts.length === 0) return null;
  return `Children: ${parts.join(", ")}.`;
}

module.exports = {
  // data access
  familyOf,
  familyOfChild,
  childrenOf,
  minorChildrenOf,
  adultChildrenOf,
  getChild,
  allChildren,
  allFamilies,
  // mutations
  createFamily,
  recordBirth,
  refreshStage,
  addBequest,
  addLearnedXp,
  markJoinedRoster,
  markLeftTown,
  recordSpouseGone,
  // summaries
  familySummary,
  // pure helpers
  stageForAge,
  isMinorStage,
  surnameOf,
  firstNameOf,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
  // constants
  STAGE_BABY,
  STAGE_CHILD,
  STAGE_TEEN,
  STAGE_ADULT,
  STAGES,
  DAY_MS,
  MAX_CHILDREN_PER_FAMILY,
};
