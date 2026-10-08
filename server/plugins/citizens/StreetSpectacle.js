"use strict";

/**
 * StreetSpectacle — the streets watch the player fight.
 *
 * Real players notice when someone drops a monster nearby ("nice",
 * "gz on the whip drop"). Citizens do the same now: a nearby citizen
 * reacts out loud when a player kills a monster in street view.
 *
 *   trivial kill  (<12 cb)  -> dry quips, the street heckles
 *   common kill   (12-79)   -> nods of respect, merchants eye the loot
 *   notable kill  (80-199)  -> cheers, the street applauds
 *   monster kill  (200+ cb)  -> the whole street stops; guards approve,
 *                                the fearful flinch
 *
 * All data tier: scripted forceChat lines, zero LLM — same precedent as
 * guard challenges and merchant ads. Moments are recorded in
 * CitizenMemory and the citizen's journal so the LLM mouth can riff on
 * them later ("saw you drop that greater demon yesterday").
 *
 * Cooldowns are strict: the wilderness is full of kills, so the street
 * comments rarely and it stays special.
 */

const { getMemory } = require("./lib/CitizenMemory");
const { getJournal } = require("./lib/CitizenJournal");
const { humanizerProfile, chance } = require("./lib/humanizer");
const { normalizeName } = require("./lib/CitizenBonds");
const { warmthOf } = require("./StreetNotices");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js
const SPECTACLE_RADIUS = 10; // tiles — close enough to see the fight

const SPECTACLE_CITIZEN_COOLDOWN_MS = 30 * 60 * 1000; // a citizen reacts at most every 30 min
const SPECTACLE_KILLER_COOLDOWN_MS = 10 * 60 * 1000; // one player's kills get a reaction at most every 10 min
const SPECTACLE_CHANCE = 0.55; // per eligible moment (monster kills always land)

// Combat-level tiers for the kill.
const TIER_TRIVIAL = "trivial"; // rats, goblins — the street heckles
const TIER_COMMON = "common"; // most grinds — nods of respect
const TIER_NOTABLE = "notable"; // a real fight — the street applauds
const TIER_MONSTER = "monster"; // a genuine monster — the street stops

const lastSpectacleByCitizen = new Map(); // username -> timestamp
const lastSpectacledKiller = new Map(); // killer name -> timestamp

// Killer-name-keyed cooldowns would grow with player churn. Prune
// entries older than a day, at most hourly. Memory-leak plug, 2026-10-07.
let lastSpectaclePruneAt = 0;
function pruneSpectacleCooldowns(nowMs) {
  if (nowMs - lastSpectaclePruneAt < 3600 * 1000) return;
  lastSpectaclePruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastSpectacleByCitizen, lastSpectacledKiller]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/** Pure: combat level -> spectacle tier. Unit-tested. */
function tierOf(combatLevel) {
  const level = Number.isFinite(combatLevel) ? combatLevel : 0;
  if (level >= 200) return TIER_MONSTER;
  if (level >= 80) return TIER_NOTABLE;
  if (level >= 12) return TIER_COMMON;
  return TIER_TRIVIAL;
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

function fillLine(line, { name, foe }) {
  return String(line)
    .replace(/\{name\}/g, name)
    .replace(/\{foe\}/g, foe);
}

const KILL_LINES = {
  [TIER_TRIVIAL]: {
    warm: [
      "Ooh, feisty one! The {foe} never stood a chance, {name}.",
      "Ha! The {foe} picked the wrong street.",
    ],
    neutral: [
      "Well. That's a {foe} handled.",
      "Street's safe from {foe}s tonight.",
    ],
    wry: [
      "Somebody call the undertaker. ({foe}, {name} — truly fearsome.)",
      "Careful, {name}. That {foe} nearly got away.",
    ],
  },
  [TIER_COMMON]: {
    warm: [
      "Clean work on that {foe}, {name}! Nice form.",
      "The {foe} didn't know what hit it. Well fought!",
    ],
    neutral: [
      "Decent kill. That {foe} was no pushover.",
      "{foe} down. The street notices, {name}.",
    ],
    wry: [
      "Not bad, {name}. The {foe} was probably having an off day.",
      "A {foe}. I suppose someone had to deal with it.",
    ],
  },
  [TIER_NOTABLE]: {
    warm: [
      "Took down a {foe}! The street applauds, {name}!",
      "Did you all SEE that?! {name} just dropped a {foe}!",
      "A {foe}! Drinks are on me if you tell that story again, {name}.",
    ],
    neutral: [
      "A {foe}. That took real steel, {name}.",
      "The whole street saw that, {name}. Well fought.",
    ],
    wry: [
      "A {foe}. Fine — I'll admit it, {name}. That was impressive.",
      "Show-off. (Genuinely well done, {name}.)",
    ],
  },
  [TIER_MONSTER]: {
    warm: [
      "BY THE GODS. {name} just slew a {foe}!",
      "A {foe}! The bards will sing of this one, {name}!",
    ],
    neutral: [
      "A {foe}, slain. Remember where you were today.",
      "Nobody's forgetting this one, {name}. A {foe}.",
    ],
    wry: [
      "A {foe}. I take back everything, {name}. Everything.",
      "Well. That's the biggest thing I've seen fall all year.",
    ],
    fearful: [
      "Sweet gods — stay back! Stay back!",
      "A {foe}! I need to sit down. I need to sit down.",
    ],
  },
};

/** Fearful citizens flinch at monsters; everyone else follows warmth. */
function voiceOf(record, tier) {
  const traits = new Set(record?.personality?.traits ?? []);
  if (
    tier === TIER_MONSTER &&
    (traits.has("fearful") || traits.has("timid") || traits.has("nervous"))
  ) {
    return "fearful";
  }
  return warmthOf(record?.personality);
}

/** Cheap distance check between two entities (same plane, Chebyshev). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return (
      Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius
    );
  } catch {
    return false;
  }
}

/**
 * Online citizens near the kill. Roster-backed so we get personality;
 * bot-host filtered so wilderness roamers never speak here.
 */
function nearbyCitizens(npc, killer, nowMs = Date.now()) {
  let director = null;
  try {
    director = require("./director/CitizenDirector").getDirector();
  } catch {
    return [];
  }
  if (!director?.roster) return [];
  let locals = [];
  try {
    locals = [...(killer.getLocalPlayers?.() ?? [])];
  } catch {
    return [];
  }
  const out = [];
  for (const local of locals) {
    if (local === killer || !isCitizenBot(local)) continue;
    let username = null;
    try {
      username = local.getUsername?.();
    } catch {
      continue;
    }
    if (!username) continue;
    const record = director.roster.get(normalizeName(username));
    if (!record || !director.isOnline(record)) continue;
    // The citizen saw the fight itself, not just the killer.
    if (!withinTiles(local, npc, SPECTACLE_RADIUS)) continue;
    out.push({ record, bot: local });
  }
  return out;
}

function npcName(npc) {
  try {
    return String(npc?.getDefinition?.()?.getName?.() ?? npc?.getName?.() ?? "beast");
  } catch {
    return "beast";
  }
}

function npcCombatLevel(npc) {
  try {
    const level = npc?.getDefinition?.()?.getCombatLevel?.();
    return Number.isFinite(level) ? level : 0;
  } catch {
    return 0;
  }
}

/**
 * A player killed a monster where the street could see: one nearby
 * citizen reacts out loud. Data tier; the reaction warms the memory and
 * journal so the citizen's LLM mouth can riff on the feat later.
 */
function onNpcKillWitnessed(event, nowMs = Date.now()) {
  const { npc, killer } = event ?? {};
  if (!npc || !isRealPlayer(killer)) return;
  // Summoned pets and owned creatures aren't street spectacles.
  try {
    const owner = npc.getOwner?.();
    if (owner && owner !== killer) return;
  } catch {
    return;
  }
  pruneSpectacleCooldowns(nowMs);

  const foe = npcName(npc);
  const tier = tierOf(npcCombatLevel(npc));
  const killerName = killer.getUsername?.() ?? "traveller";
  if (nowMs - (lastSpectacledKiller.get(killerName) ?? 0) < SPECTACLE_KILLER_COOLDOWN_MS)
    return;

  const candidates = nearbyCitizens(npc, killer, nowMs).filter(({ record }) => {
    const username = record.username;
    if (nowMs - (lastSpectacleByCitizen.get(username) ?? 0) < SPECTACLE_CITIZEN_COOLDOWN_MS)
      return false;
    // Sociable citizens speak; nervous ones keep it to themselves.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    if (tier === TIER_MONSTER) return true; // monster kills always land
    return chance(Math.random, SPECTACLE_CHANCE * sociability);
  });
  if (candidates.length === 0) return;

  const { record, bot } = pick(candidates);
  const username = record.username;
  lastSpectacleByCitizen.set(username, nowMs);
  lastSpectacledKiller.set(killerName, nowMs);

  const voice = voiceOf(record, tier);
  const line = fillLine(pick(KILL_LINES[tier][voice] ?? KILL_LINES[tier].neutral), {
    name: killerName,
    foe,
  });
  try {
    bot.forceChat?.(line.slice(0, 120));
  } catch {
    // A silent citizen.
  }

  // Remember it: they watched the player's fight.
  try {
    const memory = getMemory();
    memory.recordMeeting(username, killerName);
    memory.recordTone(username, killerName, 1);
  } catch {
    // Memory must never break the spectacle.
  }
  try {
    getJournal().log(username, "social", `Watched ${killerName} slay a ${foe}.`, {
      with: killerName,
      data: { foe, tier },
    });
  } catch {
    // The journal must never break the spectacle.
  }
}

module.exports = {
  onNpcKillWitnessed,
  // Pure helpers for the unit test.
  tierOf,
  voiceOf,
  fillLine,
  KILL_LINES,
};
