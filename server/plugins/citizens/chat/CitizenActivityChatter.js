"use strict";

/**
 * CitizenActivityChatter — citizens talk about what they're doing.
 *
 * The human player model: real players talk ABOUT what they're doing
 * ("almost 70 fishing", "this grind is killing me", "finally got the drop").
 * Chat is anchored to activity. A fisher who never mentions fishing is
 * wrong; a fisher who ONLY talks about fishing is also wrong.
 *
 * What this does (zero LLM, data tier only):
 *   1. Skilling chatter — citizens in an arrived skilling session occasionally
 *      say something short and informal about the grind, personality-scaled
 *      through citizenVoice (gruff citizens are terse, chatty ones exclaim).
 *   2. Milestone chatter — when close to a level (by real XP), the line
 *      becomes "almost 70 fishing!" instead of generic grind talk.
 *   3. Session goal announcements — once per session, when real players are
 *      near, the citizen states their plan ("gonna grind fishing today").
 *      Intents were journal-only before; now they're visible.
 *
 * What this does NOT do:
 *   - No LLM in the tick path (scripted pools only).
 *   - Never speaks when no real player is nearby — chatter is FOR players.
 *     (sayPublic's recipients are real players only anyway; this gate also
 *     keeps empty areas quiet and saves the chat-box throttle.)
 *   - Never breaks decision scoring — read-only wrt the brain.
 *   - Per-citizen cooldown (3-7 min, randomized) so one citizen doesn't
 *     narrate their whole session. Humans go quiet for stretches.
 *
 * Throttle math: ~100 online citizens, each chatting every ~5 min on
 * average, but only when watched and personality-gated (~50% pass). In a
 * busy capital with 20 citizens near a player, expect a line every
 * ~30-60s across the crowd — lively, not spammy. sayPublic's own 8s
 * chat-box throttle is the backstop.
 */

const { sayPublic } = require("./CitizenSayPublic");
const { voiceFor, voiceLine } = require("../lib/citizenVoice");
const { normalizeName } = require("../lib/CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");

// --- tuning -----------------------------------------------------------------
const CHATTER_MIN_MS = 3 * 60 * 1000; // fastest chatter cadence per citizen
const CHATTER_MAX_MS = 7 * 60 * 1000; // slowest; randomized, human pacing
const MILESTONE_FRACTION = 0.15; // within 15% of next level = "almost there"

// Per-citizen state (memory-leak plugs below).
const nextChatterAt = new Map(); // normalized username -> ms
const announcedSessions = new Set(); // sessionIds already goal-announced
let lastPruneAt = 0;

function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of nextChatterAt) {
    if (at < cutoff) nextChatterAt.delete(k);
  }
  // announcedSessions is bounded by live sessions; clear stale daily.
  if (announcedSessions.size > 5000) announcedSessions.clear();
}

// --- OSRS XP table (same formula as CitizenSkilling) --------------------------
const XP_TABLE = [0, 0];
(function buildXpTable() {
  let points = 0;
  for (let level = 1; level < 99; level++) {
    points += Math.floor(level + 300 * Math.pow(2, level / 7));
    XP_TABLE[level + 1] = Math.floor(points / 4);
  }
})();

/** XP remaining to the next level, or null if maxed/unreadable. */
function xpToNextLevel(currentXp, currentLevel) {
  if (!Number.isFinite(currentXp) || !Number.isFinite(currentLevel)) return null;
  if (currentLevel >= 99) return null;
  const nextAt = XP_TABLE[currentLevel + 1];
  if (!Number.isFinite(nextAt)) return null;
  return Math.max(0, nextAt - currentXp);
}

/** Fraction of the current level completed (0-1). */
function levelProgress(currentXp, currentLevel) {
  if (!Number.isFinite(currentXp) || !Number.isFinite(currentLevel)) return 0;
  if (currentLevel >= 99) return 1;
  if (currentLevel < 1) return 0;
  const cur = XP_TABLE[currentLevel] ?? 0;
  const next = XP_TABLE[currentLevel + 1] ?? cur + 1;
  if (next <= cur) return 1;
  return Math.min(1, Math.max(0, (currentXp - cur) / (next - cur)));
}

// --- skill mapping ------------------------------------------------------------
const SKILL_ENUM_KEYS = {
  fishing: "FISHING",
  woodcutting: "WOODCUTTING",
  mining: "MINING",
  cooking: "COOKING",
  crafting: "CRAFTING",
  smithing: "SMITHING",
  firemaking: "FIREMAKING",
  farming: "FARMING",
  hunter: "HUNTER",
  hunting: "HUNTER",
  agility: "AGILITY",
  thieving: "THIEVING",
  slayer: "SLAYER",
  runecrafting: "RUNECRAFTING",
  runecraft: "RUNECRAFTING",
  fletching: "FLETCHING",
  herblore: "HERBLORE",
  construction: "CONSTRUCTION",
};

const SKILL_LABELS = {
  fishing: "fishing",
  woodcutting: "wc",
  mining: "mining",
  cooking: "cooking",
  crafting: "crafting",
  smithing: "smithing",
  firemaking: "fm",
  farming: "farming",
  hunter: "hunter",
  hunting: "hunter",
  agility: "agility",
  thieving: "thieving",
  slayer: "slayer",
  runecrafting: "rc",
  runecraft: "rc",
  fletching: "fletching",
  herblore: "herblore",
  construction: "con",
};

// --- line pools ----------------------------------------------------------------
// Short, informal, first-person. {level} = next level when milestone-close,
// else current level. {skill} = short label. Pools are explicit (not
// generated) so they read like a real player typed them.

const SKILL_CHATTER = {
  fishing: {
    plain: [
      "fish are biting today",
      "this grind is killing me",
      "just one more net",
      "gonna hit {level} soon",
      "the one that got away was HUGE",
      "almost {level} fishing!",
    ],
    terse: ["fishing.", "grinding.", "one more net.", "almost {level}."],
  },
  woodcutting: {
    plain: [
      "timber!",
      "these trees won't chop themselves",
      "almost {level} wc",
      "my axe is getting dull lol",
      "just a few more logs",
    ],
    terse: ["timber.", "chopping.", "almost {level}."],
  },
  mining: {
    plain: [
      "this rock hates me",
      "almost {level} mining",
      "just need a few more ores",
      "my pickaxe arm is dead",
      "decent rock this one",
    ],
    terse: ["mining.", "almost {level}.", "ores."],
  },
  cooking: {
    plain: [
      "don't burn don't burn",
      "almost {level} cooking",
      "these are gonna sell nice",
      "who wants free burnt fish lol",
    ],
    terse: ["cooking.", "almost {level}."],
  },
  crafting: {
    plain: [
      "almost {level} crafting",
      "this one's coming out clean",
      "steady hands...",
      "gonna make bank off these",
    ],
    terse: ["crafting.", "almost {level}."],
  },
  _default: {
    plain: [
      "grinding away",
      "almost {level} {skill}",
      "this is taking forever lol",
      "just a bit more",
    ],
    terse: ["grinding.", "almost {level}."],
  },
};

const MILESTONE_CHATTER = {
  plain: [
    "almost {level} {skill}!",
    "so close to {level} {skill}",
    "one more level... {level} {skill} incoming",
    "{level} {skill} so soon, let's gooo",
  ],
  terse: ["almost {level}.", "so close.", "{level} soon."],
};

const GOAL_LINES = {
  earn_coins: {
    plain: ["gonna make some coins today", "market time, need coin", "coin grind today"],
    terse: ["coins today.", "market time."],
  },
  gain_xp: {
    plain: ["going for {label} today", "gonna grind {label} today", "{label}, let's go"],
    terse: ["{label} today.", "grinding {label}."],
  },
  socialize: {
    plain: ["just hanging out today", "catching up with folks", "good day to be out"],
    terse: ["hanging out.", "out and about."],
  },
  explore: {
    plain: ["gonna wander around today", "sightseeing today lol", "off to see the sights"],
    terse: ["wandering.", "sightseeing."],
  },
  _default: {
    plain: ["got plans today", "busy day ahead"],
    terse: ["busy today."],
  },
};

// --- helpers -------------------------------------------------------------------

function sessionsStore() {
  try {
    return require("../lib/CitizenSkilling")._sessions ?? new Map();
  } catch {
    return new Map();
  }
}

function activeIntentsFor(player) {
  try {
    return require("../brain/CitizenIntents").activeIntents(player) ?? [];
  } catch {
    return [];
  }
}

/** The arrived skilling session this citizen is a member of, if any. */
function skillingSessionFor(sessions, username) {
  const key = normalizeName(username);
  for (const session of sessions.values()) {
    if (!session || !session.arrived) continue;
    const members = session.members ?? [];
    for (const m of members) {
      if (normalizeName(m) === key) return session;
    }
  }
  return null;
}

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function personalityOf(bot) {
  try {
    return bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

/** Chatty citizens chatter more; taciturn ones mostly stay quiet. */
function chatterChance(personality) {
  try {
    const traits = new Set(personality?.traits ?? []);
    if (traits.has("chatty")) return 0.8;
    if (traits.has("cheerful") || traits.has("easygoing")) return 0.6;
    if (traits.has("taciturn") || traits.has("gruff") || traits.has("suspicious"))
      return 0.2;
    return 0.45;
  } catch {
    return 0.45;
  }
}

function usernameOf(bot) {
  try {
    return bot.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function fillTemplate(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

function skillLevelInfo(bot, skillId, Skill) {
  const enumKey = SKILL_ENUM_KEYS[String(skillId ?? "").toLowerCase()];
  // NB: enum values can be 0 (falsy) — check for missing key, not falsy value.
  if (!enumKey || Skill == null || !(enumKey in Skill)) return null;
  try {
    const sm = bot.getSkillManager?.();
    if (!sm) return null;
    const level = sm.getCurrentLevel(Skill[enumKey]);
    const xp = sm.getExperience?.(Skill[enumKey]) ?? 0;
    if (!Number.isFinite(level) || level < 1) return null;
    return { level, xp };
  } catch {
    return null;
  }
}

/**
 * Pick a chatter line for a citizen skilling. Milestone-aware: close to a
 * level -> "almost 70 fishing!"; otherwise grind talk.
 */
function pickSkillLine(skillId, levelInfo, personality, rng = Math.random) {
  const key = String(skillId ?? "").toLowerCase();
  const pool = SKILL_CHATTER[key] ?? SKILL_CHATTER._default;
  const label = SKILL_LABELS[key] ?? key;
  const voice = voiceFor(personality);

  let vars = { skill: label, level: levelInfo?.level ?? "" };
  let usePool = pool;

  if (levelInfo) {
    const toNext = xpToNextLevel(levelInfo.xp, levelInfo.level);
    const progress = levelProgress(levelInfo.xp, levelInfo.level);
    if (toNext !== null && (1 - progress) <= MILESTONE_FRACTION && levelInfo.level < 99) {
      // Close to the next level — milestone line with the UPCOMING level.
      vars = { skill: label, level: levelInfo.level + 1 };
      usePool = MILESTONE_CHATTER;
    }
  }

  const raw = voiceLine(voice, usePool, rng);
  return fillTemplate(raw, vars);
}

/** Pick a session-goal announcement line from the citizen's active intents. */
function pickGoalLine(intents, personality, rng = Math.random) {
  const intent = intents[Math.floor(rng() * intents.length)];
  if (!intent) return null;
  const pool = GOAL_LINES[intent.type] ?? GOAL_LINES._default;
  const voice = voiceFor(personality);
  const raw = voiceLine(voice, pool, rng);
  return fillTemplate(raw, { label: intent.label ?? "things" });
}

function sessionIdOf(session) {
  try {
    return session?.sessionId ?? session?.key ?? null;
  } catch {
    return null;
  }
}

// --- main tick ------------------------------------------------------------------

/**
 * Director tick entry. For each online citizen in an arrived skilling
 * session: occasionally chatter about the grind (milestone-aware), and
 * announce the session goal once per session. All speech via sayPublic
 * (overhead + chat box), personality-scaled, watched-only, throttled.
 */
function tickActivityChatter(director, overrides = {}) {
  const nowMs = overrides.nowMs ?? Date.now();
  pruneState(nowMs);
  const sessions = overrides.sessions ?? sessionsStore();
  if (!sessions || sessions.size === 0) return;
  const Skill = director?.api?.core?.Skill;
  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    return;
  }

  for (const record of roster) {
    try {
      if (!record || !director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot) continue;
      const username = usernameOf(bot) ?? record.username;
      if (!username) continue;
      const key = normalizeName(username);

      const session = skillingSessionFor(sessions, username);
      if (!session) continue; // not actively skilling — nothing to chatter about
      const skillId = session.skill;
      if (!skillId) continue;

      // Watched-only: chatter is for players.
      if (realPlayersNear(bot).length === 0) continue;

      const personality = personalityOf(bot);

      // Once per session: announce the plan.
      const sid = sessionIdOf(session);
      if (sid && !announcedSessions.has(sid)) {
        announcedSessions.add(sid);
        try {
          const intents = activeIntentsFor(bot);
          if (intents.length > 0 && Math.random() < chatterChance(personality)) {
            const line = pickGoalLine(intents, personality);
            if (line) sayPublic(bot, line);
          }
        } catch {
          // Goal announcement is cosmetic.
        }
        // Fall through to regular chatter below (separate cooldown).
      }

      // Throttled grind chatter.
      if (nowMs < (nextChatterAt.get(key) ?? 0)) continue;
      nextChatterAt.set(
        key,
        nowMs + CHATTER_MIN_MS + Math.random() * (CHATTER_MAX_MS - CHATTER_MIN_MS)
      );
      if (Math.random() >= chatterChance(personality)) continue;

      const levelInfo = Skill ? skillLevelInfo(bot, skillId, Skill) : null;
      const line = pickSkillLine(skillId, levelInfo, personality);
      if (line) {
        try {
          sayPublic(bot, line);
        } catch {
          // Cosmetic only.
        }
      }
    } catch {
      // Per-citizen isolation — one bad citizen never breaks the tick.
    }
  }
}

module.exports = {
  tickActivityChatter,
  // exposed for tests
  _resetForTests() {
    nextChatterAt.clear();
    announcedSessions.clear();
    lastPruneAt = 0;
  },
  _pickSkillLine: pickSkillLine,
  _pickGoalLine: pickGoalLine,
  _xpToNextLevel: xpToNextLevel,
  _levelProgress: levelProgress,
  _skillingSessionFor: skillingSessionFor,
  _chatterChance: chatterChance,
  _nextChatterAt: nextChatterAt,
  _announcedSessions: announcedSessions,
  CHATTER_MIN_MS,
  CHATTER_MAX_MS,
};
