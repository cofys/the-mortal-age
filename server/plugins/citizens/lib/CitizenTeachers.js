"use strict";

/**
 * CitizenTeachers — educators who run schools, teach children, preserve knowledge.
 *
 * WHAT IT DOES (data tier, free):
 *   - Each kingdom has a school: a teacher staff (schoolmaster, trade
 *     instructor, sage, tutors) picked deterministically from the roster
 *     and re-evaluated at most daily.
 *   - School-age citizens (deterministic ~25% of commoners) are enrolled
 *     as students; their curriculum (reading, writing, arithmetic, history,
 *     trade) advances one level per real day, persisted to
 *     data/saves/citizen-teachers.json (same pattern as CitizenMentors).
 *   - Graduation is journaled when a student reaches the bar; schools are
 *     journaled at founding. All zero LLM.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   - During school hours (08:00-14:00 server time), a materialized teacher
 *     holds a visible class: scripted lesson forceChat lines from per-subject
 *     pools, with 1-2 materialized students chiming in with scripted
 *     question/practice lines.
 *   - A real player walking into an active class gets a scripted welcome
 *     and is journaled as having attended. The LLM mouth can riff on
 *     lessons and graduations from the journal.
 *
 * Players as teachers: volunteerTeach(director, playerUsername, subject)
 * registers a player teacher; class sessions near them credit the player.
 * (Intended to be wired to NPC dialogue/quests later; the data model is here.)
 *
 * Zero LLM: scripted line pools, deterministic assignment, day-boundary
 * progression. Plain-node testable: CitizenTeachers.test.js.
 */

const path = require("path");
const fs = require("fs");
const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const CLASS_RADIUS = 14; // tiles — close enough to see/hear the lesson
const CLASS_SEARCH_RADIUS = 22; // teacher gathers students within this
const LESSON_CITIZEN_COOLDOWN_MS = 10 * 60 * 1000; // a teacher holds class this often
const LESSON_CHANCE = 0.35; // per eligible teacher per ~60s tick
const WELCOME_COOLDOWN_MS = 60 * 60 * 1000; // per teacher|player welcome
const MAX_STUDENTS_PER_KINGDOM = 6;
const SUBJECTS = Object.freeze(["reading", "writing", "arithmetic", "history", "trade"]);
const MAX_SUBJECT_LEVEL = 5;
const GRADUATION_TOTAL = 15; // avg 3 per subject
const DAY_MS = 24 * 3600 * 1000;

// Teacher types.
const SCHOOLMASTER = "schoolmaster";
const TRADE_INSTRUCTOR = "trade-instructor";
const SAGE = "sage";
const TUTOR = "tutor";
const TEACHER_TYPES = Object.freeze([SCHOOLMASTER, TRADE_INSTRUCTOR, SAGE, TUTOR]);

// Subjects each teacher type teaches.
const TEACHER_SUBJECTS = Object.freeze({
  [SCHOOLMASTER]: ["reading", "writing", "arithmetic"],
  [TRADE_INSTRUCTOR]: ["trade"],
  [SAGE]: ["history"],
  [TUTOR]: ["reading", "writing", "arithmetic", "history", "trade"],
});

const TEACHER_TITLES = Object.freeze({
  [SCHOOLMASTER]: "Schoolmaster",
  [TRADE_INSTRUCTOR]: "Trade Instructor",
  [SAGE]: "Sage",
  [TUTOR]: "Tutor",
});

// === Cooldown state ===
const lastLessonByTeacher = new Map(); // normalized teacher name -> timestamp
const lastWelcomeByTeacherPlayer = new Map(); // "teacher|player" -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - DAY_MS;
  for (const m of [lastLessonByTeacher, lastWelcomeByTeacherPlayer]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

// ============================================================================
// Scripted line pools — zero LLM. {subject} and {title} are filled in.
// ============================================================================

const LESSON_LINES = Object.freeze({
  reading: [
    "*taps the slate* Again, class — letters first, words after. Sound it out.",
    "A ledger you cannot read is a debt you cannot escape. Read with me.",
    "Today we read the founding charter. Mind the old spellings.",
  ],
  writing: [
    "Quills down, eyes up. Copy the proverb exactly as written.",
    "A steady hand makes a clear contract. Practice the strokes.",
    "Write your name ten times. Legibly. This is a school, not a tavern wall.",
  ],
  arithmetic: [
    "If three loaves cost nine coppers, what does one cost? Show your work.",
    "Count the coins in the bowl. Now count them backwards. Quickly.",
    "A merchant who cannot reckon is a beggar with stock. Again.",
  ],
  history: [
    "Before the crown, there was the river. Before the river, the stone. Remember.",
    "Ask me of the Old War and I will tell you what the songs leave out.",
    "History is written by the fed. Ask who fed the writer. Discuss.",
  ],
  trade: [
    "Measure twice, cut once — the carpenter's prayer. Watch my hands.",
    "Good leather tells you where it wants to bend. Feel it, don't force it.",
    "A clean seam sells itself. Thread the needle. Again. Slower.",
  ],
});

const STUDENT_LINES = Object.freeze([
  "But why does it work that way?",
  "I got it right this time! Did you see?",
  "Will this be on the recitation?",
]);

const WELCOME_LINES = Object.freeze([
  "Ah, a visitor! Sit, sit — the lesson is free and the benches are hard.",
  "Mind the chalk dust. You are welcome to listen, traveler.",
  "Class, we have a guest. On your best behavior. You — find a seat.",
]);

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Simple deterministic hash of a string (FNV-1a 32-bit). */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** School hours: 08:00-14:00 server-local time. Pure over a timestamp. */
function isSchoolHours(nowMs) {
  const hour = new Date(nowMs).getHours();
  return hour >= 8 && hour < 14;
}

/**
 * Deterministically true for ~25% of citizens — the school-age ones.
 * Pure over a username.
 */
function isSchoolAge(username) {
  return hashString(String(username).toLowerCase()) % 4 === 0;
}

/**
 * Assign teachers for one kingdom from the roster, deterministically.
 * Pure over (kingdomId, candidateUsernames[]) — no director needed.
 * Returns [{ username, type }].
 */
function assignTeachers(kingdomId, candidateUsernames) {
  const sorted = [...new Set(candidateUsernames)].sort();
  if (sorted.length === 0) return [];
  const pick = (slot) => sorted[hashString(`${kingdomId}:${slot}`) % sorted.length];
  const out = [];
  const used = new Set();
  const take = (slot, type) => {
    // Try the hashed slot first, then scan for an unused citizen.
    let username = pick(slot);
    if (used.has(username)) {
      username = sorted.find((u) => !used.has(u));
      if (!username) return;
    }
    used.add(username);
    out.push({ username, type });
  };
  take("schoolmaster", SCHOOLMASTER);
  if (sorted.length > 1) take("trade-instructor", TRADE_INSTRUCTOR);
  if (sorted.length > 2) take("sage", SAGE);
  // Tutors: up to 2 more unused citizens.
  for (const u of sorted) {
    if (out.length >= 5) break;
    if (used.has(u)) continue;
    used.add(u);
    out.push({ username: u, type: TUTOR });
  }
  return out;
}

/**
 * Pick student usernames for a kingdom: school-age commoners, deterministic
 * order, capped. Pure over (kingdomId, records[]) where records have
 * {username, role}.
 */
function pickStudents(kingdomId, records) {
  const eligible = records
    .filter((r) => r && r.kingdomId === kingdomId && isSchoolAge(r.username))
    .map((r) => r.username)
    .sort();
  return eligible.slice(0, MAX_STUDENTS_PER_KINGDOM);
}

/** Blank curriculum for a new student. */
function blankCurriculum() {
  const subjects = {};
  for (const s of SUBJECTS) subjects[s] = 0;
  return subjects;
}

/** Sum of subject levels. */
function curriculumTotal(subjects) {
  return SUBJECTS.reduce((n, s) => n + (Number(subjects?.[s]) || 0), 0);
}

/**
 * Advance a student's curriculum by one level in their weakest subject.
 * Pure over (subjects, nowMs). Returns the new subjects object + the subject
 * that advanced (or null if nothing could advance).
 */
function advanceCurriculum(subjects, nowMs) {
  void nowMs;
  const next = { ...subjects };
  let weakest = null;
  for (const s of SUBJECTS) {
    const lvl = Number(next[s]) || 0;
    if (lvl >= MAX_SUBJECT_LEVEL) continue;
    if (weakest === null || lvl < weakest.lvl) weakest = { subject: s, lvl };
  }
  if (!weakest) return { subjects: next, advanced: null };
  next[weakest.subject] = weakest.lvl + 1;
  return { subjects: next, advanced: weakest.subject };
}

/** True when the student's curriculum meets the graduation bar. */
function hasGraduated(subjects) {
  return curriculumTotal(subjects) >= GRADUATION_TOTAL;
}

/**
 * Decide whether this teacher should hold a visible class now.
 * Pure: (rng, lastFiredMs, nowMs) => boolean. Test this.
 */
function shouldHoldClass(rng, lastFiredMs, nowMs) {
  if (!isSchoolHours(nowMs)) return false;
  if (nowMs - (lastFiredMs || 0) < LESSON_CITIZEN_COOLDOWN_MS) return false;
  return rng() < LESSON_CHANCE;
}

/** Fill {title} and {subject} tokens in a lesson line. */
function fillLessonLine(line, teacherType, subject) {
  return String(line)
    .replace("{title}", TEACHER_TITLES[teacherType] ?? "Teacher")
    .replace("{subject}", subject ?? "");
}

// ============================================================================
// Persisted school state — data/saves/citizen-teachers.json
// (same pattern as CitizenMentors)
// ============================================================================

const DEFAULT_SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-teachers.json");
let saveFile = DEFAULT_SAVE_FILE;

class TeacherStore {
  constructor() {
    this.schools = new Map(); // kingdomId -> { foundedAt, teachers: [{username, type}] }
    this.students = new Map(); // normalized username -> { kingdomId, subjects, enrolledAt, lastAdvancedAt, graduated }
    this.playerTeachers = new Map(); // normalized username -> { subject, since }
    this.lastAssignAt = 0; // last daily teacher-assignment pass
  }

  resetForTests() {
    this.schools.clear();
    this.students.clear();
    this.playerTeachers.clear();
    this.lastAssignAt = 0;
  }

  load() {
    try {
      const raw = fs.readFileSync(saveFile, "utf8");
      const parsed = JSON.parse(raw);
      const schools = parsed?.schools ?? {};
      for (const [kingdomId, s] of Object.entries(schools)) {
        if (s && Array.isArray(s.teachers)) {
          this.schools.set(kingdomId, {
            foundedAt: Number(s.foundedAt) || Date.now(),
            teachers: s.teachers
              .filter((t) => t && t.username && TEACHER_TYPES.includes(t.type))
              .map((t) => ({ username: String(t.username), type: t.type })),
          });
        }
      }
      const students = parsed?.students ?? {};
      for (const [key, st] of Object.entries(students)) {
        if (st && st.kingdomId) {
          const subjects = blankCurriculum();
          for (const s of SUBJECTS) subjects[s] = Math.min(MAX_SUBJECT_LEVEL, Math.max(0, Number(st.subjects?.[s]) || 0));
          this.students.set(key, {
            kingdomId: String(st.kingdomId),
            subjects,
            enrolledAt: Number(st.enrolledAt) || Date.now(),
            lastAdvancedAt: Number(st.lastAdvancedAt) || 0,
            graduated: st.graduated === true,
          });
        }
      }
      const playerTeachers = parsed?.playerTeachers ?? {};
      for (const [key, pt] of Object.entries(playerTeachers)) {
        if (pt && pt.subject) {
          this.playerTeachers.set(key, {
            subject: String(pt.subject),
            since: Number(pt.since) || Date.now(),
          });
        }
      }
      this.lastAssignAt = Number(parsed?.lastAssignAt) || 0;
    } catch {
      // No save yet — start fresh.
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(saveFile), { recursive: true });
      const schools = {};
      for (const [k, s] of this.schools) schools[k] = s;
      const students = {};
      for (const [k, st] of this.students) students[k] = st;
      const playerTeachers = {};
      for (const [k, pt] of this.playerTeachers) playerTeachers[k] = pt;
      fs.writeFileSync(
        saveFile,
        JSON.stringify({ version: 1, schools, students, playerTeachers, lastAssignAt: this.lastAssignAt }, null, 1)
      );
    } catch {
      // Non-fatal: state still lives in memory for this session.
    }
  }
}

const store = new TeacherStore();
let storeLoaded = false;
function getStore() {
  if (!storeLoaded) {
    store.load();
    storeLoaded = true;
  }
  return store;
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "school", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Data tier: teacher assignment + curriculum progression (free, always)
// ============================================================================

/**
 * Ensure every kingdom with citizens has a school with teachers.
 * Deterministic assignment; re-evaluated at most once per day.
 */
function ensureSchools(director, nowMs) {
  const st = getStore();
  if (nowMs - st.lastAssignAt < DAY_MS && st.schools.size > 0) return;
  const byKingdom = new Map();
  for (const record of director.roster?.values?.() ?? []) {
    if (!record || !record.kingdomId || !record.username) continue;
    if (!byKingdom.has(record.kingdomId)) byKingdom.set(record.kingdomId, []);
    byKingdom.get(record.kingdomId).push(record);
  }
  let changed = false;
  for (const [kingdomId, records] of byKingdom) {
    const candidates = records.map((r) => r.username);
    const teachers = assignTeachers(kingdomId, candidates);
    const prev = st.schools.get(kingdomId);
    const prevKey = prev ? prev.teachers.map((t) => `${t.username}:${t.type}`).join(",") : "";
    const nextKey = teachers.map((t) => `${t.username}:${t.type}`).join(",");
    if (!prev) {
      journalEvent(teachers[0]?.username ?? "the town", `Founded the ${kingdomId} school.`);
      changed = true;
    } else if (prevKey !== nextKey) {
      journalEvent(teachers[0]?.username ?? "the town", `Took over teaching at the ${kingdomId} school.`);
      changed = true;
    }
    st.schools.set(kingdomId, { foundedAt: prev?.foundedAt ?? nowMs, teachers });
    // Enroll school-age students.
    const studentNames = pickStudents(kingdomId, records);
    for (const name of studentNames) {
      const key = normalizeName(name);
      if (!st.students.has(key)) {
        st.students.set(key, {
          kingdomId,
          subjects: blankCurriculum(),
          enrolledAt: nowMs,
          lastAdvancedAt: 0,
          graduated: false,
        });
        changed = true;
      }
    }
  }
  st.lastAssignAt = nowMs;
  if (changed) st.save();
}

/**
 * Advance enrolled students: one subject level per real day of enrollment.
 * Graduations are journaled. Pure-friendly over (store, nowMs) but journaled
 * side effects live here.
 */
function advanceStudents(nowMs) {
  const st = getStore();
  let changed = false;
  for (const [key, student] of st.students) {
    if (student.graduated) continue;
    if (nowMs - student.lastAdvancedAt < DAY_MS) continue;
    const { subjects, advanced } = advanceCurriculum(student.subjects, nowMs);
    if (!advanced) {
      // Maxed out but somehow not graduated — mark it.
      student.graduated = true;
      changed = true;
      continue;
    }
    student.subjects = subjects;
    student.lastAdvancedAt = nowMs;
    changed = true;
    if (hasGraduated(subjects)) {
      student.graduated = true;
      journalEvent(key, `Graduated from the ${student.kingdomId} school — a skilled worker now.`);
      // Announced visibly when players are near; the LLM mouth can riff from the journal.
    }
  }
  if (changed) st.save();
}

// ============================================================================
// Interaction tier: visible class sessions near real players
// ============================================================================

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Real players within radius of the citizen. */
function realPlayersNear(director, citizen, radius) {
  const out = [];
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/** Materialized citizens within radius of the teacher (for the class). */
function studentsNear(director, teacherBot, radius) {
  const out = [];
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record.username === teacherBot?.getUsername?.()) continue;
      const bot = (director.isOnline(record) ? director.getBot(record) : null);
      if (!bot || isRealPlayer(bot)) continue;
      if (withinTiles(teacherBot, bot, radius)) {
        out.push(bot);
        if (out.length >= 4) break;
      }
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/**
 * Run one visible class: lesson line + student chatter + player welcome.
 * @returns true if a class was held.
 */
function holdClass(director, record, teacher, teacherBot, nowMs, rng) {
  const st = getStore();
  const school = st.schools.get(record.kingdomId);
  const assignment = school?.teachers.find((t) => normalizeName(t.username) === normalizeName(record.username));
  const teacherType = assignment?.type ?? SCHOOLMASTER;
  const subjects = TEACHER_SUBJECTS[teacherType];
  const subject = pickOne(rng, subjects);
  const line = fillLessonLine(pickOne(rng, LESSON_LINES[subject]), teacherType, subject);
  try {
    { const _cvp = teacherBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(teacherBot, voiceLine(voiceFor(_cvp), { plain: [`*${TEACHER_TITLES[teacherType]} holds class — ${subject}*`] })); }
    { const _cvp = teacherBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(teacherBot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // Non-fatal.
  }
  journalEvent(record.username, `Taught a ${subject} lesson at the ${record.kingdomId} school.`);
  // 1-2 students chime in with scripted lines.
  const class_ = studentsNear(director, teacherBot, CLASS_SEARCH_RADIUS).slice(0, 2);
  for (const studentBot of class_) {
    try {
      { const _cvp = studentBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(studentBot, voiceLine(voiceFor(_cvp), { plain: STUDENT_LINES }, rng)); }
    } catch {
      // Non-fatal.
    }
  }
  // Welcome any real player watching who hasn't been greeted recently.
  const watchers = realPlayersNear(director, teacherBot, CLASS_RADIUS);
  for (const watcher of watchers) {
    const key = `${normalizeName(record.username)}|${normalizeName(watcher.getUsername?.() ?? "unknown")}`;
    const last = lastWelcomeByTeacherPlayer.get(key) || 0;
    if (nowMs - last < WELCOME_COOLDOWN_MS) continue;
    lastWelcomeByTeacherPlayer.set(key, nowMs);
    try {
      { const _cvp = teacherBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(teacherBot, voiceLine(voiceFor(_cvp), { plain: WELCOME_LINES }, rng)); }
    } catch {
      // Non-fatal.
    }
    journalEvent(record.username, `${watcher.getUsername?.() ?? "A traveler"} attended a ${subject} lesson.`);
  }
  return true;
}

/**
 * The tick function. Called from the director proximity tick.
 * Gate order: school hours (cheapest) -> per-teacher cooldown -> citizen
 * materialized -> real player near -> hold class.
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickTeachers(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    // Data tier runs free: schools exist and students learn whether or not
    // anyone is watching.
    ensureSchools(director, nowMs);
    advanceStudents(nowMs);

    // Interaction tier only during school hours.
    if (!isSchoolHours(nowMs)) return;

    const st = getStore();
    const rng = Math.random;
    for (const record of director.roster?.values?.() ?? []) {
      const school = st.schools.get(record?.kingdomId);
      if (!school) continue;
      const isTeacher = school.teachers.some(
        (t) => normalizeName(t.username) === normalizeName(record.username)
      );
      if (!isTeacher) continue;

      // 1. Cooldown gate — O(1), skips almost everyone.
      const key = normalizeName(record.username);
      const last = lastLessonByTeacher.get(key) || 0;
      if (!shouldHoldClass(rng, last, nowMs)) continue;

      // 2. Teacher must be materialized (near a player already).
      const teacherBot = (director.isOnline(record) ? director.getBot(record) : null);
      if (!teacherBot) continue;

      // 3. A real player must be within earshot.
      if (!anyRealPlayerNear(director, teacherBot, CLASS_RADIUS)) continue;

      // 4. Hold the class (scripted, zero LLM).
      holdClass(director, record, null, teacherBot, nowMs, rng);
      lastLessonByTeacher.set(key, nowMs);
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-teachers] tick failed:", e?.message ?? e);
  }
}

/**
 * Register a real player as a volunteer teacher. Persisted; class sessions
 * near them credit the player. Intended for NPC-dialogue/quest wiring.
 */
function volunteerTeach(director, playerUsername, subject) {
  void director;
  const st = getStore();
  const clean = SUBJECTS.includes(subject) ? subject : "reading";
  st.playerTeachers.set(normalizeName(playerUsername), { subject: clean, since: Date.now() });
  st.save();
  journalEvent(playerUsername, `Volunteered to teach ${clean} at the school.`);
  return { username: playerUsername, subject: clean };
}

/** Test-only: point the store at a temp file and force reload. */
function _setSaveFileForTests(p) {
  saveFile = p;
  storeLoaded = false;
  store.resetForTests();
}

function _resetStoreForTests() {
  store.resetForTests();
}

module.exports = {
  tickTeachers,
  volunteerTeach,
  // Pure helpers for tests:
  isSchoolHours,
  isSchoolAge,
  assignTeachers,
  pickStudents,
  blankCurriculum,
  curriculumTotal,
  advanceCurriculum,
  hasGraduated,
  shouldHoldClass,
  fillLessonLine,
  hashString,
  isRealPlayer,
  withinTiles,
  pickOne,
  // Constants:
  TEACHER_TYPES,
  TEACHER_SUBJECTS,
  TEACHER_TITLES,
  SCHOOLMASTER,
  TRADE_INSTRUCTOR,
  SAGE,
  TUTOR,
  SUBJECTS,
  MAX_SUBJECT_LEVEL,
  GRADUATION_TOTAL,
  LESSON_LINES,
  STUDENT_LINES,
  WELCOME_LINES,
  // Test plumbing:
  _setSaveFileForTests,
  _resetStoreForTests,
  _store: store,
};
