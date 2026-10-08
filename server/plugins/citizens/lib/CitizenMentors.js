"use strict";

/**
 * CitizenMentors — old hands teach the young.
 *
 * Citizens accrue real skill levels (CitizenSkilling). When a low-level
 * real player levels a skill within earshot of a citizen who has mastered
 * it (level 60+), the master may stop and teach: a scripted, diegetic
 * tip in overhead chat plus a fuller lesson in the player's chatbox.
 *
 * The first lesson founds a mentorship bond (persisted to
 * data/saves/citizen-mentors.json, same pattern as CitizenSkilling):
 * the master remembers their student, later level-ups near the master
 * bring advanced tips, and every lesson warms the CitizenMemory tone,
 * so a player who trains under the same master drifts toward friendship
 * through the existing befriend mechanics. The journal records it so
 * the LLM mouth can speak truthfully when the player asks the master
 * "what have you been teaching me?"
 *
 * All data tier, zero LLM — scripted lines, same precedent as
 * StreetNotices and RealmReactions. Fired from the onPlayerLevelUp
 * hook (not the tick), so it costs nothing when nobody is learning.
 *
 * Plain-node testable: CitizenMentors.test.js.
 */

const path = require("path");
const fs = require("fs");
const { getMemory } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");
const { skillStore, SKILLS } = require("./CitizenSkilling");
const { warmthOf } = require("../StreetNotices");
const { normalizeName } = require("./CitizenBonds");
const { agentRng, chance } = require("./humanizer");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js
const MENTOR_RADIUS = 14; // tiles — close enough to actually talk to

// A citizen is a master worth learning from at level 60 in the skill.
// Masters only lecture the young: apprentices stop being students at 50.
const MASTER_LEVEL = 60;
const APPRENTICE_MAX_LEVEL = 50;

const MENTOR_CHANCE = 0.7; // per eligible level-up (first lessons always land)
const MENTOR_CITIZEN_COOLDOWN_MS = 30 * 60 * 1000; // a master teaches at most this often
const MENTOR_APPRENTICE_COOLDOWN_MS = 10 * 60 * 1000; // a student gets one lesson per skill per while

// What a master of each skill is called in the streets.
const MENTOR_TITLES = {
  woodcutting: "woodcutter",
  fishing: "fisher",
  mining: "miner",
  cooking: "cook",
};

const lastLessonByMaster = new Map(); // username -> timestamp
const lastLessonByApprentice = new Map(); // "player|skill" -> timestamp

// Cooldown entries for removed citizens/players would linger forever.
// Prune entries older than a day, at most hourly. Memory-leak plug.
let lastMentorPruneAt = 0;
function pruneMentorCooldowns(nowMs) {
  if (nowMs - lastMentorPruneAt < 3600 * 1000) return;
  lastMentorPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastLessonByMaster, lastLessonByApprentice]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

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

function isCitizenBot(player) {
  return player?.getHostAddress?.() === BOT_HOST_ADDRESS;
}

/** tsps Skill.getName() -> "Woodcutting"; citizen skill keys are lowercase. */
function skillKeyOf(skill) {
  let raw = "";
  try {
    raw = skill?.getName?.() ?? skill?.name ?? "";
  } catch {
    raw = "";
  }
  const key = String(raw).toLowerCase().trim();
  return SKILLS[key] ? key : null;
}

/** Still learning: level 2..APPRENTICE_MAX_LEVEL. Masters don't lecture journeymen. */
function isApprenticeLevel(level) {
  return Number.isInteger(level) && level >= 2 && level <= APPRENTICE_MAX_LEVEL;
}

/** Cheap distance check between two entities (same plane, Chebyshev). */
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

// The director getter is injectable so the unit test can run without a server.
let directorGetter = null;
function getDirectorSafe() {
  try {
    if (directorGetter) return directorGetter();
    return require("../director/CitizenDirector").getDirector();
  } catch {
    return null;
  }
}

/**
 * Online master citizens of this skill near the player. Roster-backed so
 * we get personality; bot-host filtered so wilderness roamers never teach.
 */
function nearbyMasters(player, skillKey, nowMs = Date.now()) {
  const director = getDirectorSafe();
  if (!director?.roster) return [];
  let locals = [];
  try {
    locals = [...(player.getLocalPlayers?.() ?? [])];
  } catch {
    return [];
  }
  const out = [];
  for (const local of locals) {
    if (local === player || !isCitizenBot(local)) continue;
    let username = null;
    try {
      username = local.getUsername?.();
    } catch {
      continue;
    }
    if (!username) continue;
    const record = director.roster.get(normalizeName(username));
    if (!record || !director.isOnline(record)) continue;
    if (!withinTiles(local, player, MENTOR_RADIUS)) continue;
    let level = 0;
    try {
      level = skillStore.getLevel(username, skillKey);
    } catch {
      continue;
    }
    if (level < MASTER_LEVEL) continue;
    out.push({ record, bot: local, level });
  }
  return out;
}

// --- the lessons -------------------------------------------------------------
// {name} = the student's display name. Kept short enough for forceChat.

const WARM_INTROS = [
  "Ah, well done, {name}! ",
  "Ha! That's the spirit, {name}! ",
  "Fine work, {name}. ",
];

const WRY_INTROS = [
  "Hm. Not bad, {name}. ",
  "So you've finally got the hang of it, {name}. ",
  "Listen up, {name}. ",
];

const TIPS = {
  woodcutting: {
    first: [
      "Keep your axe sharp and your eyes on the regrowth — a dull axe wastes more daylight than a long walk.",
      "Chop where the grove is thickest, not closest. The trees by the gate are picked clean by midday.",
      "Rotate your trees — let each one regrow while you work the next. Patience out-chops hurry.",
    ],
    advanced: [
      "You've got the rhythm now. Try the far grove — bigger timber, fewer folk, better hauls.",
      "Watch the grain, not the swing. A clean cut along the grain and the log all but falls for you.",
      "Save your strength for the trunk. The branches are kindling; the trunk is coin.",
    ],
  },
  fishing: {
    first: [
      "The shoals run with the dawn, {name} — early nets catch best. Sleep in and you fish scraps.",
      "Keep your line still and your shadow off the water. Fish spook easier than townsfolk.",
      "A full net is worth less than a full market basket — sell fresh, never hold.",
    ],
    advanced: [
      "You're reading the water now. Deeper pools past the second buoy — that's where the big ones run.",
      "Mend your nets every trip, {name}. A torn net is just a swim lesson for fish.",
      "The market pays double for a morning catch. Time your hauls to the opening bell.",
    ],
  },
  mining: {
    first: [
      "Strike the seam, not the rock, {name} — follow the color in the stone and the ore comes easy.",
      "Never mine the pillars. A rich vein isn't worth a collapsed tunnel.",
      "Rest your arms between swings. A tired miner breaks picks, not rock.",
    ],
    advanced: [
      "You swing like a miner now. The deep workings past the second shaft — richer ore, darker dark.",
      "Tap before you commit — a hollow ring means the seam's thin, a dull thud means pay dirt.",
      "Smelt what you dig, {name}. Raw ore is heavy; bars are money.",
    ],
  },
  cooking: {
    first: [
      "Salt early, taste often, {name} — a dish you don't taste is a gamble you always lose.",
      "A hot fire and a cold head. Rush the range and you'll serve charcoal.",
      "Fresh ingredients first — no spice in the world saves a tired fish.",
    ],
    advanced: [
      "You've got the touch now. Try the slow roast — low heat, long time, and the meat falls apart.",
      "Feed a crowd the way you'd feed family, {name}. Word travels faster than flavor.",
      "Keep one signature dish perfect instead of ten dishes passable. Folk come back for the one.",
    ],
  },
};

function fillLine(line, name) {
  return String(line).replace(/\{name\}/g, name);
}

// --- the mentorship bonds (persisted) ----------------------------------------

const DEFAULT_SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-mentors.json");
let saveFile = DEFAULT_SAVE_FILE;

class MentorStore {
  constructor() {
    this.bonds = new Map(); // "mentor|apprentice|skill" -> bond
  }

  key(mentor, apprentice, skill) {
    return `${normalizeName(mentor)}|${normalizeName(apprentice)}|${skill}`;
  }

  resetForTests() {
    this.bonds.clear();
  }

  load() {
    try {
      const raw = fs.readFileSync(saveFile, "utf8");
      const parsed = JSON.parse(raw);
      const bonds = parsed?.bonds ?? {};
      for (const [key, bond] of Object.entries(bonds)) {
        if (bond && bond.mentor && bond.apprentice && bond.skill) {
          this.bonds.set(key, {
            mentor: String(bond.mentor),
            apprentice: String(bond.apprentice),
            skill: String(bond.skill),
            tipsGiven: Number(bond.tipsGiven) || 0,
            startedAt: Number(bond.startedAt) || Date.now(),
            lastTipAt: Number(bond.lastTipAt) || 0,
          });
        }
      }
    } catch {
      // No save yet — start fresh.
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(saveFile), { recursive: true });
      const bonds = {};
      for (const [key, bond] of this.bonds) bonds[key] = bond;
      fs.writeFileSync(saveFile, JSON.stringify({ version: 1, bonds }, null, 1));
    } catch {
      // Non-fatal: the bond still lives in memory for this session.
    }
  }

  getBond(mentor, apprentice, skill) {
    return this.bonds.get(this.key(mentor, apprentice, skill)) ?? null;
  }

  /** Record a lesson; creates the bond on the first one. */
  recordLesson(mentor, apprentice, skill, now = Date.now()) {
    const key = this.key(mentor, apprentice, skill);
    let bond = this.bonds.get(key);
    if (!bond) {
      bond = {
        mentor: String(mentor),
        apprentice: String(apprentice),
        skill: String(skill),
        tipsGiven: 0,
        startedAt: now,
        lastTipAt: 0,
      };
      this.bonds.set(key, bond);
    }
    bond.tipsGiven += 1;
    bond.lastTipAt = now;
    this.save();
    return bond;
  }

  /** All bonds where this player is the student (for status/debugging). */
  bondsForApprentice(apprentice) {
    const key = normalizeName(apprentice);
    const out = [];
    for (const bond of this.bonds.values()) {
      if (normalizeName(bond.apprentice) === key) out.push(bond);
    }
    return out;
  }
}

let store = null;
function getMentorStore() {
  if (!store) {
    store = new MentorStore();
    store.load();
  }
  return store;
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "mentor", text);
  } catch {
    // Non-fatal.
  }
}

function memTone(citizenName, playerName, delta) {
  try {
    getMemory().recordTone(citizenName, playerName, delta);
  } catch {
    // Non-fatal.
  }
}

function memMeeting(citizenName, playerName) {
  try {
    getMemory().recordMeeting(citizenName, playerName);
  } catch {
    // Non-fatal.
  }
}

/**
 * Player leveled a skill in earshot of a master: the old hand teaches.
 * First lessons always land (a master noticing a beginner is special);
 * follow-ups are chance-gated and cooldown-throttled. The lesson warms
 * the memory tone — students drift toward friendship with their master —
 * and is journaled so the LLM mouth can speak truthfully about it later.
 */
function onMentorLevelUpNotice(event, nowMs = Date.now()) {
  const { player, skill, newLevel } = event ?? {};
  if (!isRealPlayer(player)) return;
  const skillKey = skillKeyOf(skill);
  if (!skillKey || !isApprenticeLevel(newLevel)) return;
  pruneMentorCooldowns(nowMs);

  const masters = nearbyMasters(player, skillKey, nowMs).filter(({ record }) => {
    const username = record.username;
    if (nowMs - (lastLessonByMaster.get(username) ?? 0) < MENTOR_CITIZEN_COOLDOWN_MS) return false;
    const playerName = player.getUsername?.() ?? "";
    const key = `${normalizeName(playerName)}|${skillKey}`;
    return nowMs - (lastLessonByApprentice.get(key) ?? 0) >= MENTOR_APPRENTICE_COOLDOWN_MS;
  });
  if (masters.length === 0) return;

  const rng = agentRng(`mentors:${skillKey}:${nowMs >> 16}`);
  const playerName = player.getUsername?.() ?? "traveller";
  const s = getMentorStore();
  // Prefer a master who already teaches this student — continuity.
  const familiar = masters.filter(
    ({ record }) => s.getBond(record.username, playerName, skillKey)
  );
  const pool = familiar.length > 0 ? familiar : masters;
  const { record, bot } = pick(pool);
  const bond = s.getBond(record.username, playerName, skillKey);
  const isFirstLesson = !bond;
  if (!isFirstLesson && !chance(rng, MENTOR_CHANCE)) return;

  const tips = isFirstLesson ? TIPS[skillKey].first : TIPS[skillKey].advanced;
  const tip = fillLine(pick(tips), playerName);
  const warmth = warmthOf(record.personality);
  const intro = fillLine(pick(warmth === "wry" ? WRY_INTROS : WARM_INTROS), playerName);
  const skillLabel = MENTOR_TITLES[skillKey] ?? SKILLS[skillKey].label.toLowerCase();
  const mentorName = record.username;

  lastLessonByMaster.set(mentorName, nowMs);
  lastLessonByApprentice.set(`${normalizeName(playerName)}|${skillKey}`, nowMs);
  const newBond = s.recordLesson(mentorName, playerName, skillKey, nowMs);
  memMeeting(mentorName, playerName);
  memTone(mentorName, playerName, 1);
  journalEvent(
    mentorName,
    isFirstLesson
      ? `Took ${playerName} on as a ${skillLabel} student after their level-up.`
      : `Gave ${playerName} their ${ordinal(newBond.tipsGiven)} ${skillLabel} lesson.`,
    "mentor"
  );

  try {
    bot.forceChat?.((intro + tip).slice(0, 120));
  } catch {
    // A shy master.
  }
  try {
    player.sendMessage?.(
      `${mentorName}, master ${skillLabel}, teaches you: "${tip}"` +
        (isFirstLesson
          ? ` Train near them — masters notice their students.`
          : ``)
    );
  } catch {
    // Non-fatal.
  }
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** One-line status for debugging (mirrors favorStatus). */
function mentorStatus() {
  const s = getMentorStore();
  const out = [];
  for (const bond of s.bonds.values()) {
    out.push(
      `${bond.mentor}→${bond.apprentice}: ${bond.skill} (${bond.tipsGiven} lesson${bond.tipsGiven === 1 ? "" : "s"})`
    );
  }
  return out;
}

function resetCooldownsForTests() {
  lastLessonByMaster.clear();
  lastLessonByApprentice.clear();
  lastMentorPruneAt = 0;
}

module.exports = {
  getMentorStore,
  onMentorLevelUpNotice,
  mentorStatus,
  skillKeyOf,
  isApprenticeLevel,
  MASTER_LEVEL,
  APPRENTICE_MAX_LEVEL,
  MENTOR_RADIUS,
  MENTOR_CHANCE,
  MENTOR_CITIZEN_COOLDOWN_MS,
  MENTOR_APPRENTICE_COOLDOWN_MS,
  TIPS,
  // exposed for tests
  _setSaveFile: (p) => {
    saveFile = p;
  },
  _defaultSaveFile: DEFAULT_SAVE_FILE,
  _setDirectorGetter: (fn) => {
    directorGetter = fn;
  },
  _resetCooldownsForTests: resetCooldownsForTests,
};
