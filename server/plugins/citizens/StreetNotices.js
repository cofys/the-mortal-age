"use strict";

/**
 * StreetNotices — the streets notice the player.
 *
 * Real players congratulate each other on level-ups ("gz") and react when
 * someone dies nearby. Citizens do the same now, so a fresh character
 * grinding their first skills in a capital feels surrounded by people,
 * not props.
 *
 *   player level-up -> a nearby citizen congratulates them out loud
 *   player death    -> a nearby citizen reacts (sympathy or dry wit)
 *
 * All data tier: scripted forceChat lines, zero LLM — same precedent as
 * guard challenges and merchant ads. The moments are recorded in
 * CitizenMemory (citizens remember the player's milestones; the LLM
 * mouth can riff on them later) and the citizen's journal.
 *
 * Cooldowns are strict: a fresh character levels fast, so the street
 * cheers rarely and it stays special.
 */

const { getMemory } = require("./lib/CitizenMemory");
const { getJournal } = require("./lib/CitizenJournal");
const { humanizerProfile, chance } = require("./lib/humanizer");
const { normalizeName } = require("./lib/CitizenBonds");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js
const NOTICE_RADIUS = 14; // tiles — close enough to actually talk to

// A fresh character levels fast; the street cheers rarely so it stays special.
const CONGRATS_CITIZEN_COOLDOWN_MS = 30 * 60 * 1000; // a citizen congratulates at most every 30 min
const CONGRATS_PLAYER_COOLDOWN_MS = 10 * 60 * 1000; // a player is congratulated at most every 10 min
const CONGRATS_CHANCE = 0.6; // per eligible moment (milestones always land)
const SYMPATHY_CITIZEN_COOLDOWN_MS = 30 * 60 * 1000;
const SYMPATHY_PLAYER_COOLDOWN_MS = 15 * 60 * 1000;
const SYMPATHY_CHANCE = 0.5;

// Milestones get the big lines.
const MILESTONE_LEVELS = new Set([10, 25, 50, 70, 90, 99]);

const lastCongratsByCitizen = new Map(); // username -> timestamp
const lastCongratulatedPlayer = new Map(); // player name -> timestamp
const lastSympathyByCitizen = new Map(); // username -> timestamp
const lastSympathizedPlayer = new Map(); // player name -> timestamp

// Player-name-keyed cooldowns would grow with player churn. Prune
// entries older than a day, at most hourly. Memory-leak plug, 2026-10-07.
let lastNoticePruneAt = 0;
function pruneNoticeCooldowns(nowMs) {
  if (nowMs - lastNoticePruneAt < 3600 * 1000) return;
  lastNoticePruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [
    lastCongratsByCitizen,
    lastCongratulatedPlayer,
    lastSympathyByCitizen,
    lastSympathizedPlayer,
  ]) {
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

function isMilestone(level) {
  return MILESTONE_LEVELS.has(level);
}

/**
 * Warmth of a citizen's voice: warm traits cheer, wry traits rib, the
 * rest just nod. Pure — unit-tested.
 */
function warmthOf(personality) {
  const traits = new Set(personality?.traits ?? []);
  const demeanor = String(personality?.demeanor ?? "");
  const warm =
    traits.has("cheerful") ||
    traits.has("friendly") ||
    traits.has("kind") ||
    traits.has("warm") ||
    demeanor.includes("warm");
  if (warm) return "warm";
  const wry =
    traits.has("gruff") ||
    traits.has("cold") ||
    traits.has("surly") ||
    traits.has("bitter") ||
    traits.has("proud");
  if (wry) return "wry";
  return "neutral";
}

const LEVEL_LINES = {
  warm: [
    "Gz on {level} {skill}, {name}!",
    "Well earned — {level} {skill}! The hard yards pay off.",
    "{level} {skill}! You should be proud of that one, {name}.",
    "Ha! Look at you go — {level} {skill}!",
  ],
  neutral: [
    "Gz, {level} {skill}.",
    "Nice work, {name} — {level} {skill}.",
    "{level} {skill}. Not a bad day's work.",
  ],
  wry: [
    "Hm. {level} {skill}. Not bad, I suppose.",
    "Show-off. (Gz, {level} {skill}.)",
    "{level} {skill}, eh? Took you long enough.",
  ],
};

const MILESTONE_LINES = {
  warm: [
    "{level} {skill}! The whole street owes you a drink, {name}!",
    "By the gods — {level} {skill}! That's worth celebrating!",
    "Everyone's talking about it — {level} {skill}, {name}! Magnificent!",
  ],
  neutral: [
    "Gz on {level} {skill}, {name}. That's a real milestone.",
    "{level} {skill}. Worth remembering this one.",
    "A milestone — {level} {skill}. Well done.",
  ],
  wry: [
    "{level} {skill}. I'll admit it, {name} — that's impressive.",
    "Don't let it go to your head. (Gz on {level} {skill}.)",
    "{level} {skill}? Fine. FINE. That's genuinely well done.",
  ],
};

const DEATH_LINES = {
  warm: [
    "Ouch. The long walk back, eh {name}? Take care out there.",
    "Rough one, {name}. You'll get them next time.",
    "Easy now, friend — you're still breathing. That's what counts.",
  ],
  neutral: [
    "Rough one.",
    "The dark's not kind tonight.",
    "That looked like it hurt. Rest up, traveller.",
  ],
  wry: [
    "Walk it off, friend.",
    "That's the wilds for you. Walk it off.",
    "They'll be telling that one in the tavern. (Glad you're back, {name}.)",
  ],
};

function fillLine(line, { name, skill, level }) {
  return String(line)
    .replace(/\{name\}/g, name)
    .replace(/\{skill\}/g, skill)
    .replace(/\{level\}/g, level);
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
 * Online citizens near a real player. Roster-backed so we get personality;
 * bot-host filtered so wilderness roamers never speak here.
 */
function getDirectorSafe() {
  try {
    return require("./director/CitizenDirector").getDirector();
  } catch {
    return null;
  }
}

function nearbyCitizens(player, radius, nowMs = Date.now()) {
  const director = getDirectorSafe();
  if (!director?.roster) return [];
  const out = [];
  let locals = [];
  try {
    locals = [...(player.getLocalPlayers?.() ?? [])];
  } catch {
    return [];
  }
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
    if (!withinTiles(local, player, radius)) continue;
    out.push({ record, bot: local });
  }
  return out;
}

/**
 * Player leveled a skill in view of the street: one nearby citizen
 * congratulates them. Data tier; the congratulations warm the memory and
 * journal so the citizen's LLM mouth can riff on the milestone later.
 */
function onPlayerLevelUpNotice(event, nowMs = Date.now()) {
  const { player, skill, oldLevel, newLevel } = event ?? {};
  if (!isRealPlayer(player)) return;
  pruneNoticeCooldowns(nowMs);
  if (!Number.isInteger(newLevel) || newLevel <= (oldLevel ?? 0)) return;

  const playerName = player.getUsername?.() ?? "traveller";
  if (nowMs - (lastCongratulatedPlayer.get(playerName) ?? 0) < CONGRATS_PLAYER_COOLDOWN_MS) return;

  const candidates = nearbyCitizens(player, NOTICE_RADIUS).filter(({ record }) => {
    const username = record.username;
    if (nowMs - (lastCongratsByCitizen.get(username) ?? 0) < CONGRATS_CITIZEN_COOLDOWN_MS) return false;
    // Sociable citizens speak; nervous ones keep it to themselves.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    if (isMilestone(newLevel)) return true; // milestones always land
    return chance(Math.random, CONGRATS_CHANCE * sociability);
  });
  if (candidates.length === 0) return;

  const { record, bot } = pick(candidates);
  const username = record.username;
  lastCongratsByCitizen.set(username, nowMs);
  lastCongratulatedPlayer.set(playerName, nowMs);

  const warmth = warmthOf(record.personality);
  const pool = isMilestone(newLevel) ? MILESTONE_LINES[warmth] : LEVEL_LINES[warmth];
  let skillName = "that skill";
  try {
    skillName = String(skill?.getName?.() ?? skill?.name ?? "that skill");
  } catch {
    skillName = "that skill";
  }
  const line = fillLine(pick(pool), { name: playerName, skill: skillName, level: newLevel });
  try {
    bot.forceChat?.(line.slice(0, 120));
  } catch {
    // A shy citizen.
  }

  // Remember it: they were there for the player's milestone.
  try {
    const memory = getMemory();
    memory.recordMeeting(username, playerName);
    memory.recordTone(username, playerName, 1);
  } catch {
    // Memory must never break the notice.
  }
  try {
    getJournal().log(username, "social", `Congratulated ${playerName} on level ${newLevel} ${skillName}.`, {
      with: playerName,
      data: { level: newLevel, skill: skillName },
    });
  } catch {
    // The journal must never break the notice.
  }
}

/**
 * Player died where the street could see: one nearby citizen reacts.
 * Warm citizens sympathize, wry ones rib — the tavern will remember.
 */
function onPlayerDeathNotice(event, nowMs = Date.now()) {
  const { player } = event ?? {};
  if (!isRealPlayer(player)) return;
  pruneNoticeCooldowns(nowMs);

  const playerName = player.getUsername?.() ?? "traveller";
  if (nowMs - (lastSympathizedPlayer.get(playerName) ?? 0) < SYMPATHY_PLAYER_COOLDOWN_MS) return;

  const candidates = nearbyCitizens(player, NOTICE_RADIUS).filter(({ record }) => {
    const username = record.username;
    if (nowMs - (lastSympathyByCitizen.get(username) ?? 0) < SYMPATHY_CITIZEN_COOLDOWN_MS) return false;
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    return chance(Math.random, SYMPATHY_CHANCE * sociability);
  });
  if (candidates.length === 0) return;

  const { record, bot } = pick(candidates);
  const username = record.username;
  lastSympathyByCitizen.set(username, nowMs);
  lastSympathizedPlayer.set(playerName, nowMs);

  const line = fillLine(pick(DEATH_LINES[warmthOf(record.personality)]), {
    name: playerName,
    skill: "",
    level: "",
  });
  try {
    bot.forceChat?.(line.slice(0, 120));
  } catch {
    // A silent citizen.
  }

  try {
    getMemory().recordMeeting(username, playerName);
  } catch {
    // Memory must never break the notice.
  }
  try {
    getJournal().log(username, "social", `Watched ${playerName} die — a hard day.`, {
      with: playerName,
    });
  } catch {
    // The journal must never break the notice.
  }
}

module.exports = {
  onPlayerLevelUpNotice,
  onPlayerDeathNotice,
  // Pure helpers for the unit test.
  isMilestone,
  warmthOf,
  fillLine,
  LEVEL_LINES,
  MILESTONE_LINES,
  DEATH_LINES,
};
