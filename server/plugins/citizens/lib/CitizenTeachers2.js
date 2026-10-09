"use strict";

/**
 * CitizenTeachers2 — informal educators: home tutors, trade mentors, village
 * schoolmasters, and public scholars.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived educator types, per-day lesson schedules, pupil rosters,
 *   graduation events, and 7-day TTL player ledgers for tutor hires, class
 *   attendance, and mentoring requests. Reads the real CitizenLibrarians
 *   catalog for study materials and the real CitizenTeachers curriculum
 *   subjects, so the fiction stays consistent.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 09:00-15:00): scripted lesson emotes, pupil callouts, tutor offers,
 * mentor encouragement, graduation fanfare as the crowd moment.
 *
 * No overlap (by design):
 * - Professional CitizenTeachers own the KINGDOM schools (schoolmasters,
 *   trade instructors, sages, tutors assigned deterministically per
 *   kingdom via assignTeachers). Assigned professional teachers are
 *   EXCLUDED from this module — this one owns the informal side: home
 *   tutoring, village schools, trade mentoring, public wisdom talks.
 * - CitizenMentors own REACTIVE skill-master lessons on player level-ups
 *   (event-driven, master level 60+). This module's mentors run SCHEDULED
 *   trade-mentoring sessions between citizens on the tick — different
 *   trigger, different population.
 * - CitizenLibrarians own the library stacks; tutors here only borrow
 *   their catalog for study materials.
 *
 * Zero LLM: scripted line pools; the journal feeds the LLM mouth.
 *
 * Activity system (no professional exclusion chain): any commoner may teach.
 * Plain-node testable: CitizenTeachers2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning ===
const TUTOR_RADIUS = 14; // tiles — close enough to see/hear
const TUTOR_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen teaches this often
const TUTOR_CHANCE = 0.35; // per eligible citizen per tick
// Nominal roll share. Activity system: every commoner may teach, so 100%
// nominal (minus the handful of professional teachers per kingdom).
const EDUCATOR_SHARE = 100;
const CLASS_START_HOUR = 9; // 09:00 server-local
const CLASS_END_HOUR = 15; // 15:00 server-local
const GRADUATION_CHANCE = 0.1; // per venue per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Educator types ===
const EDUCATOR_TUTOR = "tutor";
const EDUCATOR_MENTOR = "mentor";
const EDUCATOR_SCHOOLMASTER = "schoolmaster";
const EDUCATOR_SCHOLAR = "scholar";
const EDUCATOR_TYPES = [
  EDUCATOR_TUTOR,
  EDUCATOR_MENTOR,
  EDUCATOR_SCHOOLMASTER,
  EDUCATOR_SCHOLAR,
];
const EDUCATOR_WEIGHTS = {
  [EDUCATOR_TUTOR]: 30,
  [EDUCATOR_MENTOR]: 30,
  [EDUCATOR_SCHOOLMASTER]: 25,
  [EDUCATOR_SCHOLAR]: 15,
};

// === Venues (kingdom-preferred, informal) ===
const VENUES = [
  { name: "the Lumbridge Village School", kingdom: "misthalin" },
  { name: "the Varrock Kitchen School", kingdom: "misthalin" },
  { name: "the Falador Back-Room Academy", kingdom: "asgarnia" },
  { name: "the Burthorpe Cadet School", kingdom: "asgarnia" },
  { name: "the Ardougne Lecture Court", kingdom: "kandarin" },
  { name: "the Catherby Seaside School", kingdom: "kandarin" },
  { name: "the Keldagrim Apprentice Hall", kingdom: "keldagrim" },
  { name: "the Dorgesh Learning Circle", kingdom: "keldagrim" },
  { name: "the Darkmeyer Quiet Academy", kingdom: "morytania" },
  { name: "the Al Kharid School of Letters", kingdom: "kharidian" },
];

// === Pupil name pool (deterministic rosters, zero storage) ===
const PUPIL_NAMES = [
  "Pip", "Maren", "Tobin", "Sella", "Bran", "Wren", "Dain", "Lissa",
  "Corb", "Nessa", "Hald", "Ilsa", "Rurik", "Tilda", "Osric", "Fenna",
  "Garr", "Ysolde", "Perrin", "Anwen",
];

// Fallback subjects if the teachers module is absent.
const FALLBACK_SUBJECTS = ["reading", "writing", "arithmetic", "history", "trade"];

// ============================================================================
// Scripted line pools — zero LLM. {slots} are filled in.
// ============================================================================

const LESSON_LINES = {
  [EDUCATOR_TUTOR]: [
    "*taps the slate* Again — letters first, words after. Sound it out.",
    "A contract you cannot read is a debt you cannot escape. Read with me.",
    "Quills down, eyes up. Copy the proverb exactly as written.",
    "If three loaves cost nine coppers, what does one cost? Show your work.",
  ],
  [EDUCATOR_MENTOR]: [
    "Measure twice, cut once — the craftsman's prayer. Watch my hands.",
    "Good leather tells you where it wants to bend. Feel it, don't force it.",
    "A clean seam sells itself. Thread the needle. Again. Slower.",
    "Watch the master, then try. Then watch again. That's the whole secret.",
  ],
  [EDUCATOR_SCHOOLMASTER]: [
    "Settle down, class. Slates out. Mind the chalk dust.",
    "Who can tell me what the river was called before the crown? Hands up.",
    "Mind your letters, mind your manners. Both will feed you one day.",
    "Recite the founding charter with me. And mean it this time.",
  ],
  [EDUCATOR_SCHOLAR]: [
    "Gather round — today I speak of the Old War, and what the songs leave out.",
    "History is written by the fed. Ask who fed the writer. Discuss.",
    "Before the crown, there was the river. Before the river, the stone. Remember.",
    "A question well asked is worth ten answers. Who has one?",
  ],
};

// (PUPIL_LINES removed 2026-10-08 with fabrication branches.)

const OFFER_LINES = {
  [EDUCATOR_TUTOR]: [
    "Lessons for the young, friend — reading, reckoning, writing. Fair rates.",
    "Does your little one need letters? I teach afternoons, reasonable coin.",
  ],
  [EDUCATOR_MENTOR]: [
    "I take on apprentices, friend — honest trade, honest teaching.",
    "Got a youngster with quick hands? Bring them by. I'll show them the trade.",
  ],
  [EDUCATOR_SCHOOLMASTER]: [
    "The village school takes pupils, friend — all children welcome.",
    "Bring the little ones by {venue}. We'll make scholars of them yet.",
  ],
  [EDUCATOR_SCHOLAR]: [
    "I lecture at {venue}, friend — all are welcome to listen and learn.",
    "Wisdom is free at my talks. Bring questions, take answers.",
  ],
};

const GRADUATION_LINES = [
  "Stand tall, {pupil}! You have earned your letters — the village is proud!",
  "Behold our graduate: {pupil} can read, reckon, and reason. Well done!",
  "From slate to scroll — {pupil} graduates today! Three cheers!",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Ledgers (7-day TTL) ===
const hires = new Map(); // normName -> { at }
const attendances = new Map(); // normName -> { at }
const mentorRequests = new Map(); // normName -> { at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const m of [hires, attendances, mentorRequests]) {
    for (const [k, v] of m) {
      if (nowMs - v.at > LEDGER_TTL_MS) m.delete(k);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Weighted pick of an educator type from a 0..99 roll. */
function educatorTypeFromRoll(roll) {
  let acc = 0;
  for (const t of EDUCATOR_TYPES) {
    acc += EDUCATOR_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return EDUCATOR_TUTOR;
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

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
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

/** Class hours: 09:00-15:00 server-local time. */
function isClassHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= CLASS_START_HOUR && h < CLASS_END_HOUR;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

// ============================================================================
// Professional-teacher exclusion — the kingdom schools belong to
// CitizenTeachers. Assigned professional teachers are excluded here.
// Cached per (kingdomId, day): computed once per kingdom per day, so the
// per-tick cost is one Map lookup.
// ============================================================================

const proTeacherCache = new Map(); // "kingdomId:day" -> Set(normalized names)

function proTeachersFor(director, kingdomId, nowMs) {
  const key = `${kingdomId ?? "?"}:${dayNumber(nowMs)}`;
  const hit = proTeacherCache.get(key);
  if (hit) return hit;
  // Bound the cache — one entry per kingdom per day is plenty.
  if (proTeacherCache.size > 32) proTeacherCache.clear();
  const set = new Set();
  try {
    const teachers = require("./CitizenTeachers");
    if (typeof teachers.assignTeachers === "function") {
      const names = [];
      for (const r of director?.roster?.values?.() ?? []) {
        if (r?.kingdomId === kingdomId && r?.username) names.push(r.username);
      }
      for (const t of teachers.assignTeachers(kingdomId, names)) {
        set.add(normalizeName(t.username));
      }
    }
  } catch {
    /* module absent — no exclusion */
  }
  proTeacherCache.set(key, set);
  return set;
}

// ============================================================================
// Educator identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The educator type for a roster record, or null.
 * Commoners only; assigned professional teachers (CitizenTeachers'
 * kingdom schools) are excluded.
 * @param {object} record - roster record
 * @param {object} [director] - CitizenDirector (needed for the pro-teacher
 *   exclusion; without it the exclusion is skipped)
 * @param {number} [nowMs] - timestamp for the exclusion cache
 */
function educatorTypeOf(record, director, nowMs) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the kingdom schools belong to the professional teachers.
    if (director && typeof nowMs === "number") {
      const pros = proTeachersFor(director, record?.kingdomId, nowMs);
      if (pros.has(name)) return null;
    }
    const roll = hashStr("educator:" + name) % 100;
    if (roll >= EDUCATOR_SHARE) return null;
    return educatorTypeFromRoll(hashStr("educatortype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred venue, stable across restarts. */
function venueFor(record) {
  const kid = record?.kingdomId;
  const local = VENUES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : VENUES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("tutorvenue:" + name) % pool.length];
}

/** The day's subjects for an educator — from the real school curriculum. */
function curriculumSubjects() {
  try {
    const teachers = require("./CitizenTeachers");
    if (Array.isArray(teachers.SUBJECTS) && teachers.SUBJECTS.length) {
      return teachers.SUBJECTS.slice();
    }
  } catch {
    /* module absent */
  }
  return FALLBACK_SUBJECTS.slice();
}

// (lessonsFor removed 2026-10-08: hash-derived fabrication.)

// (pupilsFor removed 2026-10-08: hash-derived fabrication.)

// (studyMaterialFor removed 2026-10-08: hash-derived fabrication.)

// (graduationFor removed 2026-10-08: hash-derived fabrication.)

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** A player hires a tutor: recorded; the LLM tier handles dialogue. */
function hireTutor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  hires.set(name, { at: nowMs });
  return name;
}

/** The active tutor hire for a player, or null. */
function hireFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = hires.get(name);
  return rec ? { hiredAt: rec.at } : null;
}

/** A player attends a class: recorded; the LLM tier handles dialogue. */
function attendClass(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  attendances.set(name, { at: nowMs });
  return name;
}

/** The active class attendance for a player, or null. */
function attendanceFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = attendances.get(name);
  return rec ? { attendedAt: rec.at } : null;
}

/** A player requests a mentor: recorded; the LLM tier handles dialogue. */
function requestMentor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  mentorRequests.set(name, { at: nowMs });
  return name;
}

/** The active mentor request for a player, or null. */
function mentorFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = mentorRequests.get(name);
  return rec ? { requestedAt: rec.at } : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

function journalize(citizen, text) {
  try {
    const journal = require("./CitizenJournal");
    if (typeof journal.appendEntry === "function") {
      journal.appendEntry(citizen, text);
    } else if (typeof journal.addEntry === "function") {
      journal.addEntry(citizen, text);
    }
  } catch {
    /* journal absent */
  }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch {
    /* rumors absent */
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → educator? → visibility → materialized →
// class hours → real player near → chance → work.
// ============================================================================

function tickEducators(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < TUTOR_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be an educator (hash-derived, cheap)
        const type = educatorTypeOf(record, director, nowMs);
        if (!type) continue;

        // 3. Visibility weighting — primary hobby always, others 1-in-3
        if (!isHobbyVisible(record.username, "tutor")) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Class hours only
        if (!isClassHour(now)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, TUTOR_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, TUTOR_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doEducatorWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-teachers2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-teachers2] tick failed:", e?.message ?? e);
  }
}

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

function doEducatorWork(director, record, citizen, type, nowMs) {
  const venue = venueFor(record);

  // Graduation: once per venue per graduation day, the crowd moment.
  // (Crowd-moment fabrication block removed 2026-10-08: graduationFor was hash-derived.)

  // Routine: honest ambient chatter only — teaching, offers.
  // (lessonsFor/pupilsFor removed 2026-10-08: hash-derived "today's lesson"
  // and pupil names were fabrication — no real pupils answered.)
  const roll = Math.random();
  if (roll < 0.6) {
    const line = fill(pickOne(Math.random, LESSON_LINES[type]), {
      subject: "reading",
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `taught at ${venue.name}`);
  } else {
    const line = fill(pickOne(Math.random, OFFER_LINES[type]), {
      venue: venue.name,
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `offered ${type} lessons at ${venue.name}`);
  }
}

module.exports = {
  tickEducators,
  hireTutor,
  hireFor,
  attendClass,
  attendanceFor,
  requestMentor,
  mentorFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  educatorTypeOf,
  venueFor,
  curriculumSubjects,
  proTeachersFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  educatorTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isClassHour,
  dayNumber,
  chance,
  seededRng,
  EDUCATOR_TYPES,
  EDUCATOR_TUTOR,
  EDUCATOR_MENTOR,
  EDUCATOR_SCHOOLMASTER,
  EDUCATOR_SCHOLAR,
  VENUES,
  PUPIL_NAMES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    hires.clear();
    attendances.clear();
    mentorRequests.clear();
    proTeacherCache.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
