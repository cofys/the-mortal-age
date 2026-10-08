"use strict";

/**
 * StreetFarewells — the street notices when a player leaves it.
 *
 * Real streets murmur when someone walks away mid-conversation: a warm
 * send-off, a merchant's "come back soon", a gruff regular's muttered
 * "finally, some peace". Citizens do the same now: when a real player
 * logs out within earshot of a roster-backed citizen, one nearby citizen
 * bids them farewell — out loud, in character.
 *
 * All data tier: scripted forceChat lines, zero LLM — same precedent as
 * StreetNotices, StreetSpectacle and hawker callouts. The moment is
 * recorded in CitizenMemory so the citizen's LLM mouth can riff on it
 * later ("you mentioned leaving last night — back already?").
 *
 * Citizen sleep-logouts are NOT farewells: the handler ignores departing
 * citizen bots (isRealPlayer guard), so the street doesn't hold a
 * send-off every time a citizen's shift ends.
 *
 * Cooldowns are strict: one citizen speaks at most every 20 minutes, one
 * departing player gets a farewell at most every 30 minutes, and the
 * street only speaks about half the time — farewells stay special.
 */

const { getMemory } = require("./lib/CitizenMemory");
const { humanizerProfile, chance } = require("./lib/humanizer");
const { normalizeName } = require("./lib/CitizenBonds");
const { warmthOf } = require("./StreetNotices");

const FAREWELL_RADIUS = 12; // tiles — earshot of the logout spot

const FAREWELL_CITIZEN_COOLDOWN_MS = 20 * 60 * 1000; // a citizen speaks at most every 20 min
const FAREWELL_PLAYER_COOLDOWN_MS = 30 * 60 * 1000; // one player's logout gets a farewell at most every 30 min
const FAREWELL_CHANCE = 0.55; // per eligible logout, scaled by sociability
const FAREWELL_MERCHANT_BONUS = 0.25; // merchants always pitch the return visit

const lastFarewellByCitizen = new Map(); // username -> timestamp
const lastFarewellForPlayer = new Map(); // departing player name -> timestamp

// Player-name-keyed cooldowns would grow with player churn. Prune
// entries older than a day, at most hourly. Memory-leak plug, 2026-10-07.
let lastFarewellPruneAt = 0;
function pruneFarewellCooldowns(nowMs) {
  if (nowMs - lastFarewellPruneAt < 3600 * 1000) return;
  lastFarewellPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastFarewellByCitizen, lastFarewellForPlayer]) {
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

function fillLine(line, { name }) {
  return String(line).replace(/\{name\}/g, name);
}

const FAREWELL_LINES = {
  warm: [
    "Safe travels, {name}! The street'll miss you.",
    "Gods keep you, {name} — come back soon!",
    "Leaving already, {name}? Safe journey!",
    "Farewell, {name}! Don't be a stranger.",
  ],
  neutral: [
    "Safe travels, {name}.",
    "Off you go then, {name}. Watch the roads.",
    "Until next time, {name}.",
    "Farewell, {name}. Mind the mud on the way out.",
  ],
  wry: [
    "Running from your problems again, {name}? Safe travels.",
    "Off so soon, {name}? The tavern will cope.",
    "Try not to die out there, {name}.",
    "Don't do anything I wouldn't do, {name}. (Short list.)",
  ],
  merchant: [
    "Safe travels, {name}! Come back soon — new stock tomorrow!",
    "Farewell! My stall's always open when you return, {name}.",
    "Mind the roads, {name} — and spend those coins here first!",
  ],
  // The gruff and the fearful don't send anyone off; they mutter to the
  // street itself. Deliberately no {name}: they're not talking to them.
  dismissive: [
    "Finally, some peace.",
    "Hmph. One less elbow in the market.",
    "Oh good. Quiet again.",
    "About time. The street's mine again.",
  ],
};

const DISMISSIVE_TRAITS = new Set([
  "fearful",
  "timid",
  "nervous",
  "gruff",
  "cold",
  "surly",
  "bitter",
]);

/**
 * Farewell voice for a citizen. The gruff and fearful mutter to the
 * street; merchants pitch the return visit; everyone else follows warmth.
 * Pure — unit-tested.
 */
function voiceOf(record) {
  const traits = new Set(record?.personality?.traits ?? []);
  for (const trait of traits) {
    if (DISMISSIVE_TRAITS.has(trait)) return "dismissive";
  }
  if (record?.merchantKind) return "merchant";
  return warmthOf(record?.personality);
}

/** Chebyshev distance to an entity, or Infinity when off-plane. */
function tilesTo(ax, ay, az, b) {
  try {
    const lb = b.getLocation?.();
    if (!lb || az !== lb.getZ()) return Infinity;
    return Math.max(Math.abs(ax - lb.getX()), Math.abs(ay - lb.getY()));
  } catch {
    return Infinity;
  }
}

/**
 * Online roster-backed citizens within earshot of the logout spot.
 * Roster-iterated (bounded: ~100 records) rather than trusting the
 * departing player's local-players list — the player is mid-logout and
 * that list may already be torn down. Returns [{ record, bot, dist }].
 */
function nearbyFarewellers(player, nowMs = Date.now()) {
  let director = null;
  try {
    director = require("./director/CitizenDirector").getDirector();
  } catch {
    return [];
  }
  if (!director?.roster) return [];
  let px, py, pz;
  try {
    const loc = player.getLocation?.();
    if (!loc) return [];
    px = loc.getX();
    py = loc.getY();
    pz = loc.getZ();
  } catch {
    return [];
  }
  const out = [];
  for (const record of director.roster.values()) {
    if (!record || !director.isOnline(record)) continue;
    let bot = null;
    try {
      bot = director.getBot(record);
    } catch {
      continue;
    }
    if (!bot) continue;
    const dist = tilesTo(px, py, pz, bot);
    if (dist > FAREWELL_RADIUS) continue;
    out.push({ record, bot, dist });
  }
  return out;
}

/**
 * Pure cooldown gates with injectable timestamps. Module maps stay
 * private; the test exercises these. Unit-tested.
 */
function playerFarewellAllowed(playerName, nowMs = Date.now()) {
  return (
    nowMs - (lastFarewellForPlayer.get(playerName) ?? 0) >=
    FAREWELL_PLAYER_COOLDOWN_MS
  );
}

function isFarewellAllowed(citizenName, playerName, nowMs = Date.now()) {
  if (
    nowMs - (lastFarewellByCitizen.get(citizenName) ?? 0) <
    FAREWELL_CITIZEN_COOLDOWN_MS
  )
    return false;
  return playerFarewellAllowed(playerName, nowMs);
}

/**
 * A real player logged out within earshot of the street: the nearest
 * eligible citizen bids them farewell. Data tier; the moment warms the
 * memory so the citizen's LLM mouth can riff on the parting later.
 */
function onLogoutFarewell(event, nowMs = Date.now()) {
  const { player } = event ?? {};
  // Guard: null payloads, and citizen sleep-logouts get no send-off.
  if (!isRealPlayer(player)) return;
  pruneFarewellCooldowns(nowMs);

  const playerName = player.getUsername?.() ?? "traveller";
  if (!playerFarewellAllowed(playerName, nowMs)) return;

  const candidates = nearbyFarewellers(player, nowMs).filter(({ record }) => {
    const username = record.username;
    if (!isFarewellAllowed(username, playerName, nowMs)) return false;
    // Sociable citizens speak; quiet ones usually keep it to themselves.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    let p = FAREWELL_CHANCE * sociability;
    if (record.merchantKind) p = Math.min(1, p + FAREWELL_MERCHANT_BONUS);
    return chance(Math.random, p);
  });
  if (candidates.length === 0) return;

  // Nearest crowd pick: the closest citizen is the one who saw them go.
  candidates.sort((a, b) => a.dist - b.dist);
  const { record, bot } = candidates[0];
  const username = record.username;
  lastFarewellByCitizen.set(username, nowMs);
  lastFarewellForPlayer.set(playerName, nowMs);

  const voice = voiceOf(record);
  const line = fillLine(pick(FAREWELL_LINES[voice] ?? FAREWELL_LINES.neutral), {
    name: playerName,
  });
  try {
    bot.forceChat?.(line.slice(0, 120));
  } catch {
    // A silent citizen.
  }

  // Remember it: they saw the player leave.
  try {
    const memory = getMemory();
    memory.recordMeeting(username, playerName);
    memory.recordTone(username, playerName, 1);
  } catch {
    // Memory must never break the farewell.
  }
}

module.exports = {
  onLogoutFarewell,
  // Pure helpers for the unit test.
  voiceOf,
  fillLine,
  isFarewellAllowed,
  playerFarewellAllowed,
  FAREWELL_LINES,
};
