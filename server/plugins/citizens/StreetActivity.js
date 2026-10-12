"use strict";

/**
 * StreetActivity — the streets notice what the player is DOING.
 *
 * Real players comment when someone's grinding a skill nearby ("nice
 * spot", "gl") or fighting something ("careful!"). Citizens do the same
 * now: on the slow tick, a nearby citizen occasionally reacts out loud
 * when a real player is visibly skilling (woodcutting/fishing/mining
 * animation) or fighting.
 *
 *   skilling  -> nods, encouragement, the odd dry quip
 *   fighting  -> "careful", cheers, wry commentary from a safe distance
 *
 * All data tier: scripted sayPublic lines through citizenVoice, zero LLM —
 * the same rung pattern as StreetNotices/StreetSpectacle (radius check,
 * cooldowns, personality-scaled chance, sayPublic). Moments are recorded
 * in CitizenMemory and the citizen's journal so the LLM mouth can riff on
 * them later ("saw you chopping by the mill yesterday").
 *
 * Cooldowns are strict and the chance is low: a busy bank must never
 * become a wall of text. Errs on the side of too quiet.
 */

const { getMemory } = require("./lib/CitizenMemory");
const { getJournal } = require("./lib/CitizenJournal");
const { agentRng, humanizerProfile, chance } = require("./lib/humanizer");
const { warmthOf, fillLine } = require("./StreetNotices");
const { voiceFor, voiceLine } = require("./lib/citizenVoice");
const { sayPublic } = require("./chat/CitizenSayPublic");
const { ATTR_CITIZEN_PERSONALITY } = require("./constants");

const ACTIVITY_RADIUS = 10; // tiles — close enough to see what they're doing

// Strict, like the other street rungs: a grind spot stays quiet.
const ACTIVITY_CITIZEN_COOLDOWN_MS = 15 * 60 * 1000; // a citizen reacts at most every 15 min
const ACTIVITY_PLAYER_COOLDOWN_MS = 10 * 60 * 1000; // a player's activity gets a reaction at most every 10 min
const ACTIVITY_CHANCE = 0.3; // per eligible moment, personality-scaled
const MAX_REACTIONS_PER_TICK = 1; // one reaction per slow tick, world-wide

const ACT_WOODCUTTING = "woodcutting";
const ACT_FISHING = "fishing";
const ACT_MINING = "mining";
const ACT_FIGHTING = "fighting";

// Skilling animation ids, verified against the skill plugins (2026-10-11):
//   plugins/skills/Fishing.plugin.js      ANIM = { HARPOON: 618, CAGE: 619, BIG_NET: 620, NET: 621, ROD: 622 }
//   plugins/skills/Mining.plugin.js       pickaxe anims 624-629
//   plugins/skills/Woodcutting.plugin.js  axe animationId table (standard + felling)
const FISHING_ANIMS = new Set([618, 619, 620, 621, 622]);
const MINING_ANIMS = new Set([624, 625, 626, 627, 628, 629]);
const WOODCUTTING_ANIMS = new Set([
  867, 869, 871, 873, 875, 877, 879, // standard axes, bronze..rune
  2117, 2846, 7264, 8303, 8324, 8778, // infernal/dragon/3rd-age/gilded/crystal
  10064, 10065, 10066, 10067, 10068, 10069, 10070, 10071, 10072, 10074, // felling axes
]);

const lastActivityByCitizen = new Map(); // username -> timestamp
const lastActivityPlayer = new Map(); // player name -> timestamp

// Player-name-keyed cooldowns would grow with player churn. Prune
// entries older than a day, at most hourly. Memory-leak plug, same as the
// other street rungs.
let lastActivityPruneAt = 0;
function pruneActivityCooldowns(nowMs) {
  if (nowMs - lastActivityPruneAt < 3600 * 1000) return;
  lastActivityPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastActivityByCitizen, lastActivityPlayer]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/** Pure: skilling animation id -> activity, or null. Unit-tested. */
function skillOfAnim(animId) {
  if (!Number.isInteger(animId)) return null;
  if (FISHING_ANIMS.has(animId)) return ACT_FISHING;
  if (MINING_ANIMS.has(animId)) return ACT_MINING;
  if (WOODCUTTING_ANIMS.has(animId)) return ACT_WOODCUTTING;
  return null;
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

/**
 * What a real player is visibly doing: fighting, skilling, or nothing we
 * can name. Pure engine reads; anything that throws yields null.
 */
function classifyPlayerActivity(player) {
  try {
    if (player.inCombat?.() === true) return ACT_FIGHTING;
  } catch {
    // Fall through to the animation check.
  }
  let animId = null;
  try {
    animId = player.getAnimation?.()?.getId?.() ?? player.getAnimation?.();
  } catch {
    return null;
  }
  return skillOfAnim(animId);
}

const ACTIVITY_LINES = {
  [ACT_WOODCUTTING]: {
    warm: [
      "Nice rhythm on those trees, {name}!",
      "Chop chop! The woodpile thanks you, {name}.",
      "Good form, {name} — mind the splinters!",
    ],
    neutral: [
      "Steady work, {name}.",
      "Those trees won't chop themselves.",
      "A fair pile of logs coming along.",
    ],
    wry: [
      "Timber's cheaper when you chop it yourself, eh {name}?",
      "Mind your toes, {name}.",
      "Another tree bites the dust.",
    ],
  },
  [ACT_FISHING]: {
    warm: [
      "Nice spot, {name}!",
      "The fish are biting today, {name}!",
      "Good luck out there, {name}!",
    ],
    neutral: [
      "Patience is the whole game.",
      "Quiet water today.",
      "A fine place to cast a line.",
    ],
    wry: [
      "Tell the fish I said hello, {name}.",
      "Hope they're biting better for you than for me.",
      "Fishing: the art of waiting, professionally.",
    ],
  },
  [ACT_MINING]: {
    warm: [
      "Strike it rich, {name}!",
      "Good swing, {name} — the rock fears you.",
      "Shiny ones at the bottom, they say!",
    ],
    neutral: [
      "Hard rock, honest work.",
      "Steady, {name}. The vein runs deep.",
      "Mind the dust.",
    ],
    wry: [
      "The rock always wins eventually, {name}.",
      "Digging to the centre of the world?",
      "Careful — that pick's seen things.",
    ],
  },
  [ACT_FIGHTING]: {
    warm: [
      "Careful now, {name} — you've got this!",
      "Gl, {name}!",
      "Go on, {name}! The street's with you!",
    ],
    neutral: [
      "Watch its reach, {name}.",
      "Keep your guard up.",
      "A clean fight. The street's watching.",
    ],
    wry: [
      "Try not to bleed on the cobbles, {name}.",
      "Bold. Or foolish. We'll see.",
      "That's one way to make friends.",
    ],
  },
};

function activityLabel(activity) {
  switch (activity) {
    case ACT_WOODCUTTING:
      return "chopping wood";
    case ACT_FISHING:
      return "fishing";
    case ACT_MINING:
      return "mining";
    case ACT_FIGHTING:
      return "fighting";
    default:
      return "busy";
  }
}

/**
 * Slow-tick pass: the street notices what real players are doing. One
 * nearby citizen at most reacts out loud per tick; long cooldowns keep a
 * grind spot quiet. Called from CitizenSocial's greet tick slot (the
 * director and plugin wiring are sibling-owned, so it chains from there).
 */
function tickActivityReactions(director, nowMs = Date.now(), excludedUsernames = new Set()) {
  if (!director?.roster) return;
  pruneActivityCooldowns(nowMs);
  const rng = agentRng(`activity:${Math.floor(nowMs / 60000)}`);
  let reacted = 0;

  for (const record of director.roster.values()) {
    if (reacted >= MAX_REACTIONS_PER_TICK) break;
    if (excludedUsernames.has(record.username)) continue;
    if (!director.isOnline(record)) continue;
    const username = record.username;
    if (nowMs - (lastActivityByCitizen.get(username) ?? 0) < ACTIVITY_CITIZEN_COOLDOWN_MS)
      continue;
    const bot = director.getBot(record);
    if (!bot) continue;
    try {
      if (bot.inCombat?.() === true) continue;
    } catch {
      // Assume free on error — a missed line is worse than a mistimed one.
    }

    // A visibly active real player: fighting or mid-skill-animation.
    let target = null;
    let targetName = null;
    let activity = null;
    try {
      for (const local of bot.getLocalPlayers?.() ?? []) {
        if (local === bot || !isRealPlayer(local)) continue;
        if (!withinTiles(bot, local, ACTIVITY_RADIUS)) continue;
        const name = local.getUsername?.();
        if (!name) continue;
        if (nowMs - (lastActivityPlayer.get(name) ?? 0) < ACTIVITY_PLAYER_COOLDOWN_MS) continue;
        const act = classifyPlayerActivity(local);
        if (!act) continue;
        target = local;
        targetName = name;
        activity = act;
        break;
      }
    } catch {
      continue;
    }
    if (!target) continue;

    // Sociable citizens comment; nervous ones watch in silence.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    if (!chance(rng, ACTIVITY_CHANCE * sociability)) continue;

    lastActivityByCitizen.set(username, nowMs);
    lastActivityPlayer.set(targetName, nowMs);
    reacted += 1;

    // Turn to face them, like a person would.
    try {
      const tile = target.getLocation?.();
      if (tile && bot.face) bot.face(tile.getX(), tile.getY());
    } catch {
      // Cosmetic.
    }

    const pool =
      ACTIVITY_LINES[activity]?.[warmthOf(record.personality)] ??
      ACTIVITY_LINES[activity]?.neutral ??
      ACTIVITY_LINES[ACT_FIGHTING].neutral;
    const line = fillLine(pick(pool), { name: targetName, skill: "", level: "" });
    try {
      const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] }));
    } catch {
      // A silent citizen.
    }

    // Remember it: they watched the player at work.
    try {
      const memory = getMemory();
      memory.recordMeeting(username, targetName);
    } catch {
      // Memory must never break the reaction.
    }
    try {
      getJournal().log(username, "social", `Watched ${targetName} ${activityLabel(activity)}.`, {
        with: targetName,
        data: { activity },
      });
    } catch {
      // The journal must never break the reaction.
    }
  }
}

/** Clear reaction cooldowns (tests). */
function resetForTests() {
  lastActivityByCitizen.clear();
  lastActivityPlayer.clear();
}

module.exports = {
  tickActivityReactions,
  // Pure helpers for the unit test.
  skillOfAnim,
  classifyPlayerActivity,
  activityLabel,
  ACTIVITY_LINES,
  ACT_WOODCUTTING,
  ACT_FISHING,
  ACT_MINING,
  ACT_FIGHTING,
  resetForTests,
};
