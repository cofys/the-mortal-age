"use strict";

/**
 * CitizenPhilosophy — schools of thought, philosophers, debates, and academies.
 *
 * Complements (does not duplicate) CitizenFaith: that module owns gods,
 * devotion, priests, temples, and holy wars. This module owns the SECULAR
 * intellectual layer: philosophical schools, philosophers, public debates,
 * academies, and wisdom. A citizen can be both devout (CitizenFaith) and
 * philosophical (this module) — the two systems read each other defensively.
 *
 * Schools of thought (5, each with a patron god affinity for flavor):
 *   - stoics: endurance, duty, virtue. Affinity: saradomin.
 *   - epicureans: friendship, pleasure, the good life. Affinity: hearthmother.
 *   - skeptics: question everything, doubt as virtue. Affinity: silent_one.
 *   - naturalists: nature, balance, the wild mind. Affinity: guthix.
 *   - ambitionists: power, achievement, the will. Affinity: zamorak.
 *
 * Philosophers: citizens with thoughtful/curious/wise traits who join a
 * school. They gain wisdom from contemplation (slow tick), debates, and
 * teaching. Wisdom 80+ earns the "sage" reputation deed.
 *
 * Debates: weekly public debates at each kingdom's academy. Philosophers
 * argue their school's position; the winner gains wisdom and fame.
 * Announced via sayPublic near real players.
 *
 * Academies: one per kingdom, deterministic tile near the market (same
 * pattern as schools/guild halls). Philosophers gather, contemplate,
 * and teach here.
 *
 * Education tie-in: philosophers with wisdom 50+ teach philosophy in
 * schools (CitizenSchools), giving pupils a small wisdom bonus that
 * feeds back into their education XP bonus.
 *
 * Zero LLM. All state transitions are pure functions of stored state.
 * Plain-node testable: CitizenPhilosophy.test.js.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "saves",
  "citizen-philosophy.json"
);

function _setSavePathForTests(p) {
  module.exports._saveFileOverride = p;
}
function _saveFile() {
  return module.exports._saveFileOverride || SAVE_FILE;
}

// ---------------------------------------------------------------------------
// School catalog
// ---------------------------------------------------------------------------

const SCHOOLS = Object.freeze({
  stoics: Object.freeze({
    name: "Stoics",
    epithet: "the Enduring",
    tenets: ["duty", "endurance", "virtue"],
    godAffinity: "saradomin",
    favoredTraits: ["dutiful", "patient", "disciplined", "resolute", "calm"],
    debateLine: "Virtue is the only true good — all else is indifferent.",
  }),
  epicureans: Object.freeze({
    name: "Epicureans",
    epithet: "the Content",
    tenets: ["friendship", "pleasure", "the good life"],
    godAffinity: "hearthmother",
    favoredTraits: ["friendly", "warm", "generous", "easygoing", "sociable"],
    debateLine: "The good life is found in friendship and simple pleasures.",
  }),
  skeptics: Object.freeze({
    name: "Skeptics",
    epithet: "the Questioning",
    tenets: ["doubt", "inquiry", "intellectual honesty"],
    godAffinity: "silent_one",
    favoredTraits: ["curious", "analytical", "thoughtful", "cautious", "sharp"],
    debateLine: "Question everything — certainty is the enemy of wisdom.",
  }),
  naturalists: Object.freeze({
    name: "Naturalists",
    epithet: "the Wild-Minded",
    tenets: ["nature", "balance", "the wild"],
    godAffinity: "guthix",
    favoredTraits: ["thoughtful", "patient", "observant", "free", "calm"],
    debateLine: "Nature is the greatest teacher — observe and learn.",
  }),
  ambitionists: Object.freeze({
    name: "Ambitionists",
    epithet: "the Driven",
    tenets: ["power", "achievement", "the will"],
    godAffinity: "zamorak",
    favoredTraits: ["ambitious", "bold", "driven", "competitive", "proud"],
    debateLine: "The will to achieve is the highest virtue of all.",
  }),
});

const SCHOOL_IDS = Object.freeze(Object.keys(SCHOOLS));

// Wisdom thresholds
const WISDOM_SAGE = 80; // earns sage reputation deed
const WISDOM_TEACHER = 50; // can teach philosophy in schools
const WISDOM_DEBATER = 30; // can participate in debates

// --- state -------------------------------------------------------------------

let cache = null; // { philosophers: { [norm]: { school, wisdom, debatesWon, ... } }, academies: {...}, debates: [...] }
let dirty = false;

function blankState() {
  return {
    philosophers: Object.create(null), // norm(username) -> { school, wisdom, debatesWon, debatesLost, lastContemplation, isTeacher }
    academies: Object.create(null), // kingdomId -> { foundedAt, debateCount }
    debates: [], // [{ kingdomId, scheduledAt, participants: [], winner, topic }]
    lastDebateByKingdom: Object.create(null),
  };
}

function _load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const raw = fs.readFileSync(_saveFile(), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (data.philosophers && typeof data.philosophers === "object") {
        cache.philosophers = data.philosophers;
      }
      if (data.academies && typeof data.academies === "object") {
        cache.academies = data.academies;
      }
      if (Array.isArray(data.debates)) {
        cache.debates = data.debates;
      }
      if (data.lastDebateByKingdom && typeof data.lastDebateByKingdom === "object") {
        cache.lastDebateByKingdom = data.lastDebateByKingdom;
      }
    }
  } catch {
    // No save file yet — start blank.
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(_saveFile()), { recursive: true });
    fs.writeFileSync(_saveFile(), JSON.stringify(_load(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function _markDirty() {
  dirty = true;
}

function resetForTests() {
  cache = null;
  dirty = false;
  module.exports._saveFileOverride = null;
}

// --- helpers -------------------------------------------------------------------

function norm(username) {
  return String(username || "").toLowerCase().trim();
}

function schoolFor(schoolId) {
  return SCHOOLS[schoolId] || null;
}

// Pick the best school for a citizen based on personality traits.
// Returns schoolId or null if no traits match.
function bestSchoolForTraits(traits) {
  if (!Array.isArray(traits) || !traits.length) return null;
  const traitSet = new Set(traits.map((t) => String(t).toLowerCase()));
  let best = null;
  let bestScore = 0;
  for (const schoolId of SCHOOL_IDS) {
    const school = SCHOOLS[schoolId];
    let score = 0;
    for (const favored of school.favoredTraits) {
      if (traitSet.has(favored)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = schoolId;
    }
  }
  return bestScore > 0 ? best : null;
}

// --- philosopher registry -------------------------------------------------------

function isPhilosopher(username) {
  const state = _load();
  return !!state.philosophers[norm(username)];
}

function philosopherFor(username) {
  const state = _load();
  return state.philosophers[norm(username)] || null;
}

function joinSchool(username, schoolId) {
  const school = schoolFor(schoolId);
  if (!school) return { ok: false, reason: "unknown-school" };
  const state = _load();
  const key = norm(username);
  if (state.philosophers[key]) {
    return { ok: false, reason: "already-philosopher" };
  }
  state.philosophers[key] = {
    username: String(username),
    school: schoolId,
    wisdom: 10, // starting wisdom
    debatesWon: 0,
    debatesLost: 0,
    lastContemplation: 0,
    isTeacher: false,
    joinedAt: Date.now(),
  };
  _markDirty();
  return { ok: true, school: schoolId };
}

function leaveSchool(username) {
  const state = _load();
  const key = norm(username);
  if (!state.philosophers[key]) return false;
  delete state.philosophers[key];
  _markDirty();
  return true;
}

// Add wisdom (capped 0-100). Returns new wisdom.
function addWisdom(username, amount) {
  const state = _load();
  const key = norm(username);
  const phil = state.philosophers[key];
  if (!phil) return null;
  phil.wisdom = Math.max(0, Math.min(100, phil.wisdom + amount));
  _markDirty();
  return phil.wisdom;
}

function wisdomFor(username) {
  const phil = philosopherFor(username);
  return phil ? phil.wisdom : 0;
}

function isSage(username) {
  return wisdomFor(username) >= WISDOM_SAGE;
}

function canTeach(username) {
  return wisdomFor(username) >= WISDOM_TEACHER;
}

function canDebate(username) {
  return wisdomFor(username) >= WISDOM_DEBATER;
}

// Record a debate result. Winner gains wisdom, loser gains a little too (learning).
function recordDebate(winnerUsername, loserUsernames) {
  const state = _load();
  const winnerKey = norm(winnerUsername);
  const winner = state.philosophers[winnerKey];
  if (winner) {
    winner.debatesWon++;
    winner.wisdom = Math.min(100, winner.wisdom + 5);
  }
  for (const loser of loserUsernames || []) {
    const loserPhil = state.philosophers[norm(loser)];
    if (loserPhil) {
      loserPhil.debatesLost++;
      loserPhil.wisdom = Math.min(100, loserPhil.wisdom + 2); // learn from defeat
    }
  }
  _markDirty();
  return { ok: true };
}

// --- academies -------------------------------------------------------------------

function academyFor(kingdomId) {
  const state = _load();
  const key = String(kingdomId || "default");
  if (!state.academies[key]) {
    state.academies[key] = {
      kingdomId: key,
      foundedAt: Date.now(),
      debateCount: 0,
    };
    _markDirty();
  }
  return state.academies[key];
}

// --- debates -------------------------------------------------------------------

const DEBATE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // weekly debates

function shouldHoldDebate(kingdomId, nowMs) {
  const state = _load();
  const key = String(kingdomId || "default");
  const last = state.lastDebateByKingdom[key] || 0;
  return nowMs - last >= DEBATE_COOLDOWN_MS;
}

function scheduleDebate(kingdomId, participantUsernames, topic, nowMs) {
  const state = _load();
  const key = String(kingdomId || "default");
  const debate = {
    kingdomId: key,
    scheduledAt: nowMs || Date.now(),
    participants: (participantUsernames || []).map(String),
    winner: null,
    topic: String(topic || "the nature of the good life"),
  };
  state.debates.push(debate);
  state.lastDebateByKingdom[key] = debate.scheduledAt;
  const academy = academyFor(key);
  academy.debateCount++;
  _markDirty();
  return debate;
}

function resolveDebate(debateIndex, winnerUsername) {
  const state = _load();
  const debate = state.debates[debateIndex];
  if (!debate || debate.winner) return { ok: false, reason: "invalid-debate" };
  debate.winner = String(winnerUsername);
  const losers = debate.participants.filter(
    (p) => norm(p) !== norm(winnerUsername)
  );
  recordDebate(winnerUsername, losers);
  _markDirty();
  return { ok: true, winner: winnerUsername, losers };
}

function philosophersInKingdom(kingdomId, roster) {
  // roster: iterable of { username, kingdomId } — defensive
  const result = [];
  try {
    const state = _load();
    const key = String(kingdomId || "default");
    for (const record of roster || []) {
      if (!record || String(record.kingdomId || "default") !== key) continue;
      const phil = state.philosophers[norm(record.username)];
      if (phil) result.push({ username: record.username, ...phil });
    }
  } catch {
    // Never throw on roster issues.
  }
  return result;
}

function topSages(limit) {
  const state = _load();
  const all = Object.values(state.philosophers);
  all.sort((a, b) => b.wisdom - a.wisdom);
  return all.slice(0, Math.max(1, limit || 5));
}

// --- contemplation ---------------------------------------------------------------

const CONTEMPLATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const CONTEMPLATION_WISDOM = 3;

function canContemplate(username, nowMs) {
  const phil = philosopherFor(username);
  if (!phil) return false;
  return (nowMs || Date.now()) - (phil.lastContemplation || 0) >= CONTEMPLATION_COOLDOWN_MS;
}

function contemplate(username, nowMs) {
  const state = _load();
  const key = norm(username);
  const phil = state.philosophers[key];
  if (!phil) return { ok: false, reason: "not-philosopher" };
  const now = nowMs || Date.now();
  if (now - (phil.lastContemplation || 0) < CONTEMPLATION_COOLDOWN_MS) {
    return { ok: false, reason: "too-soon" };
  }
  phil.lastContemplation = now;
  phil.wisdom = Math.min(100, phil.wisdom + CONTEMPLATION_WISDOM);
  _markDirty();
  return { ok: true, wisdom: phil.wisdom };
}

// --- teaching -------------------------------------------------------------------

// Philosophers with wisdom 50+ can teach in schools. Returns teaching bonus.
function teachingBonusFor(username) {
  const phil = philosopherFor(username);
  if (!phil || phil.wisdom < WISDOM_TEACHER) return 0;
  // 1-5 bonus based on wisdom above threshold
  return Math.min(5, 1 + Math.floor((phil.wisdom - WISDOM_TEACHER) / 10));
}

module.exports = {
  SCHOOLS,
  SCHOOL_IDS,
  WISDOM_SAGE,
  WISDOM_TEACHER,
  WISDOM_DEBATER,
  DEBATE_COOLDOWN_MS,
  _setSavePathForTests,
  resetForTests,
  save,
  schoolFor,
  bestSchoolForTraits,
  isPhilosopher,
  philosopherFor,
  joinSchool,
  leaveSchool,
  addWisdom,
  wisdomFor,
  isSage,
  canTeach,
  canDebate,
  recordDebate,
  academyFor,
  shouldHoldDebate,
  scheduleDebate,
  resolveDebate,
  philosophersInKingdom,
  topSages,
  canContemplate,
  contemplate,
  teachingBonusFor,
};
