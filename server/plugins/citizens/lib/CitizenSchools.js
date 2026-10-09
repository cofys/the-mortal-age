"use strict";

/**
 * CitizenSchools — the data layer for citizen schooling.
 *
 * Relationship to CitizenTeachers (existing, live): CitizenTeachers assigns
 * teacher staff, runs visible classes for roster citizens, and tracks a
 * curriculum per adult student. This module is the part it doesn't have:
 *   - physical schoolhouses: one per kingdom, a real tile near the market
 *   - FAMILY CHILDREN as pupils: CitizenFamilies data records in child/teen
 *     stage (CitizenTeachers only enrolls roster adults — the town's actual
 *     children never went to school until now)
 *   - tuition funding: 25 coins/day/child from the parents' real coins;
 *     offline parents accrue debt; 7 days unpaid → unenrolled
 *   - the education XP bonus: graduated pupils learn faster as adults
 *     (0–15%, read by CitizenSkilling.grantXpWithCelebration)
 *
 * All state is real, nothing hash-derived: enrollment comes from actual
 * family child records, literacy/numeracy from lessons actually attended,
 * tuition from coins actually paid.
 *
 * Data tier, zero LLM. The dynamics (founding, enrollment, lessons,
 * tuition, graduation) live in lib/CitizenSchoolLife.js, which the
 * director ticks. The foreground (chat, LLM) reads this and roleplays
 * from it — "I went to the Falador schoolhouse" is a real record.
 *
 * Persisted to data/saves/citizen-schools.json (never committed).
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-schools.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// === Tuning: all magic numbers here ===
const DAY_MS = 24 * 3600 * 1000;
const TUITION_PER_DAY = 25; // coins per pupil per day, from the parents
const TUITION_DEBT_LIMIT_DAYS = 7; // unpaid this long → unenrolled
const SCHOOL_CAPACITY = 12; // pupils per schoolhouse
const MIN_CHILDREN_FOR_SCHOOL = 4; // a kingdom needs this many school-age children to found one
const LITERACY_PER_LESSON = 2; // points per tick-lesson
const NUMERACY_PER_LESSON = 2;
const MAX_SCORE = 100;
const MAX_XP_BONUS = 0.15; // graduates learn up to 15% faster

// === State ===
let cache = null;
let dirty = false;

function blankData() {
  return { schools: {}, pupils: {} };
}

function data() {
  if (!cache) cache = load();
  return cache;
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return blankData();
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return blankData();
    if (!raw.schools || typeof raw.schools !== "object") raw.schools = {};
    if (!raw.pupils || typeof raw.pupils !== "object") raw.pupils = {};
    return raw;
  } catch {
    return blankData();
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

// === Schoolhouses ===

/** Pretty kingdom name for the schoolhouse sign. */
function kingdomDisplay(kingdomId) {
  const id = String(kingdomId ?? "");
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Deterministic schoolhouse tile: off the kingdom's market tile by a
 * kingdom-stable offset, so the schoolhouse never moves between restarts
 * and never stacks on the market itself.
 */
function schoolTileFor(kingdomId) {
  let base = { x: 3200, y: 3200, z: 0 };
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    base = siteTileByKingdom(kingdomId, "market") ?? base;
  } catch {
    // fall back to the default
  }
  // Stable per-kingdom offset from the name hash (not Math.random).
  let h = 0;
  const s = String(kingdomId ?? "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const dx = 14 + (h % 8);
  const dy = 10 + ((h >> 4) % 8);
  return { x: base.x + dx, y: base.y + dy, z: base.z ?? 0 };
}

function schoolOfKingdom(kingdomId) {
  const d = data();
  return d.schools[String(kingdomId ?? "").toLowerCase()] ?? null;
}

function foundSchool(kingdomId, teacherUsername) {
  const d = data();
  const key = String(kingdomId ?? "").toLowerCase();
  if (!key || d.schools[key]) return d.schools[key] ?? null;
  const school = {
    kingdomId: key,
    name: `${kingdomDisplay(key)} Schoolhouse`,
    tile: schoolTileFor(key),
    teacher: teacherUsername ? String(teacherUsername) : null,
    foundedAt: Date.now(),
  };
  d.schools[key] = school;
  markDirty();
  return school;
}

function setTeacher(kingdomId, teacherUsername) {
  const d = data();
  const school = d.schools[String(kingdomId ?? "").toLowerCase()];
  if (!school) return false;
  school.teacher = teacherUsername ? String(teacherUsername) : null;
  markDirty();
  return true;
}

// === Pupils (family children) ===

/** A family child record is school-age in child or teen stage. */
function isSchoolAgeChild(child) {
  if (!child || child.leftTown || child.joinedRoster) return false;
  return child.stage === "child" || child.stage === "teen";
}

function blankPupil(child) {
  return {
    childId: child.id,
    display: child.display,
    kingdomId: child.kingdomId,
    enrolledAt: Date.now(),
    lastTuitionAt: Date.now(),
    lessonsAttended: 0,
    literacy: 0,
    numeracy: 0,
    tuitionDebtDays: 0,
    graduated: false,
    graduatedAt: null,
  };
}

function pupilOf(childId) {
  const d = data();
  return d.pupils[String(childId)] ?? null;
}

function pupilsOfKingdom(kingdomId) {
  const d = data();
  const key = String(kingdomId ?? "").toLowerCase();
  return Object.values(d.pupils).filter(
    (p) =>
      String(p.kingdomId ?? "").toLowerCase() === key &&
      !p.graduated &&
      p.enrolled !== false
  );
}

/** Every currently-enrolled pupil across all kingdoms. */
function allPupils() {
  const d = data();
  return Object.values(d.pupils).filter((p) => !p.graduated && p.enrolled !== false);
}

function enrollPupil(child) {
  const d = data();
  if (!child || !child.id) return null;
  if (d.pupils[child.id]) return d.pupils[child.id];
  const school = schoolOfKingdom(child.kingdomId);
  if (!school) return null;
  if (pupilsOfKingdom(child.kingdomId).length >= SCHOOL_CAPACITY) return null;
  const pupil = blankPupil(child);
  d.pupils[child.id] = pupil;
  markDirty();
  return pupil;
}

function unenrollPupil(childId, reason) {
  const d = data();
  const pupil = d.pupils[String(childId)];
  if (!pupil || pupil.graduated) return false;
  pupil.graduated = false;
  pupil.unenrolledAt = Date.now();
  pupil.unenrollReason = reason ?? "left";
  // Keep the record (with its lessons) so re-enrollment resumes honestly.
  pupil.enrolled = false;
  markDirty();
  return true;
}

function isEnrolled(childId) {
  const p = pupilOf(childId);
  return !!p && !p.graduated && p.enrolled !== false;
}

/** One lesson: literacy and numeracy climb toward 100. */
function recordLesson(childId) {
  const d = data();
  const pupil = d.pupils[String(childId)];
  if (!pupil || pupil.graduated || pupil.enrolled === false) return false;
  pupil.lessonsAttended += 1;
  pupil.literacy = Math.min(MAX_SCORE, pupil.literacy + LITERACY_PER_LESSON);
  pupil.numeracy = Math.min(MAX_SCORE, pupil.numeracy + NUMERACY_PER_LESSON);
  markDirty();
  return true;
}

function graduatePupil(childId) {
  const d = data();
  const pupil = d.pupils[String(childId)];
  if (!pupil || pupil.graduated) return false;
  pupil.graduated = true;
  pupil.graduatedAt = Date.now();
  markDirty();
  return true;
}

function addTuitionDebt(childId) {
  const d = data();
  const pupil = d.pupils[String(childId)];
  if (!pupil || pupil.graduated) return 0;
  pupil.tuitionDebtDays += 1;
  markDirty();
  return pupil.tuitionDebtDays;
}

function clearTuitionDebt(childId, atMs) {
  const d = data();
  const pupil = d.pupils[String(childId)];
  if (!pupil) return;
  pupil.tuitionDebtDays = 0;
  pupil.lastTuitionAt = atMs ?? Date.now();
  markDirty();
}

/**
 * The education XP bonus for a roster citizen: graduates learn faster.
 * Matches graduated pupil records to roster usernames by display name.
 * Returns 0..MAX_XP_BONUS.
 */
function xpBonusFor(username) {
  const key = normalizeName(username);
  if (!key) return 0;
  const d = data();
  let best = 0;
  for (const pupil of Object.values(d.pupils)) {
    if (!pupil.graduated) continue;
    if (normalizeName(pupil.display) !== key) continue;
    const score = (Number(pupil.literacy) || 0) + (Number(pupil.numeracy) || 0);
    const bonus = Math.min(MAX_XP_BONUS, (score / (2 * MAX_SCORE)) * MAX_XP_BONUS);
    if (bonus > best) best = bonus;
  }
  return best;
}

/** One-line schooling summary for chat/LLM context. */
function schoolingSummary(childId) {
  const pupil = pupilOf(childId);
  if (!pupil) return null;
  const school = schoolOfKingdom(pupil.kingdomId);
  return {
    display: pupil.display,
    school: school ? school.name : null,
    literacy: pupil.literacy,
    numeracy: pupil.numeracy,
    lessons: pupil.lessonsAttended,
    graduated: pupil.graduated,
  };
}

module.exports = {
  // tuning
  TUITION_PER_DAY,
  TUITION_DEBT_LIMIT_DAYS,
  SCHOOL_CAPACITY,
  MIN_CHILDREN_FOR_SCHOOL,
  MAX_XP_BONUS,
  // schoolhouses
  schoolOfKingdom,
  foundSchool,
  setTeacher,
  schoolTileFor,
  kingdomDisplay,
  // pupils
  isSchoolAgeChild,
  pupilOf,
  pupilsOfKingdom,
  allPupils,
  enrollPupil,
  unenrollPupil,
  isEnrolled,
  recordLesson,
  graduatePupil,
  addTuitionDebt,
  clearTuitionDebt,
  // effects
  xpBonusFor,
  schoolingSummary,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
};
