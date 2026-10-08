"use strict";

/**
 * StreetIdle — the street notices when a player goes still in it.
 *
 * Real streets notice the person who hasn't moved in ten minutes: a
 * warm neighbour checks they're alright, a wry regular jokes they've
 * turned to stone, a merchant invites them to browse. Citizens do the
 * same now: when a real player stands on the same tile for ten minutes
 * in street view of a roster-backed citizen, the nearest eligible
 * citizen comments — out loud, in character.
 *
 * This fills a genuine gap: StreetNotices covers level-ups and deaths,
 * StreetSpectacle covers monster kills, StreetFarewells covers logouts,
 * but nothing covered a player standing idle for a long stretch.
 *
 * All data tier: scripted forceChat lines, zero LLM — same precedent as
 * the other street rungs. The moment is recorded in CitizenMemory so the
 * citizen's LLM mouth can riff on it later ("you were rooted to that
 * spot yesterday — everything alright?").
 *
 * The handler runs on onPlayerProcess (~600ms per player), so it is
 * deliberately cheap: a module-level evaluation gate means real work
 * happens at most every 30 seconds, and per-player tracking is a small
 * Map keyed by username. After a nudge the player is marked until they
 * move — tile change clears the tracking so the next still spell is
 * measured from scratch. Logout clears the entry outright.
 *
 * Cooldowns are strict: one citizen speaks at most every 30 minutes,
 * one idle player gets a nudge at most every 45 minutes, and the street
 * only speaks about half the time — idle comments stay special.
 */

const { getMemory } = require("./lib/CitizenMemory");
const { humanizerProfile, chance } = require("./lib/humanizer");
const { normalizeName } = require("./lib/CitizenBonds");
const { warmthOf } = require("./StreetNotices");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js
const IDLE_RADIUS = 10; // tiles — close enough to notice someone standing still
const IDLE_EVAL_INTERVAL_MS = 30 * 1000; // tick gate: real work at most every 30s
const IDLE_AFK_THRESHOLD_MS = 10 * 60 * 1000; // same tile for 10 min = AFK

const IDLE_CITIZEN_COOLDOWN_MS = 30 * 60 * 1000; // a citizen nudges at most every 30 min
const IDLE_PLAYER_COOLDOWN_MS = 45 * 60 * 1000; // one player's stillness gets a nudge at most every 45 min
const IDLE_CHANCE = 0.5; // per eligible AFK moment, scaled by sociability

const idleWatch = new Map(); // player name -> { x, y, z, sinceMs, nudged }
const lastNudgeByCitizen = new Map(); // username -> timestamp
const lastNudgeForPlayer = new Map(); // idle player name -> timestamp

// Name-keyed maps would grow with player churn. Prune entries older
// than a day, at most hourly. Memory-leak plug, 2026-10-07.
let lastIdlePruneAt = 0;
let lastIdleEvalAt = 0;
function pruneIdleState(nowMs) {
  if (nowMs - lastIdlePruneAt < 3600 * 1000) return;
  lastIdlePruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastNudgeByCitizen, lastNudgeForPlayer]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  // Stale watch entries (players who vanished without a logout hook).
  for (const [k, entry] of idleWatch) {
    if ((entry?.sinceMs ?? 0) < cutoff) idleWatch.delete(k);
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

function fillLine(line, { name }) {
  return String(line).replace(/\{name\}/g, name);
}

/**
 * Pure: two tracked tiles are the same spot. Unit-tested.
 */
function sameTile(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Pure: a tracked entry has stood still long enough to count as AFK,
 * with an injectable timestamp. Unit-tested.
 */
function isAfk(entry, nowMs) {
  if (!entry || !Number.isFinite(entry.sinceMs)) return false;
  return nowMs - entry.sinceMs >= IDLE_AFK_THRESHOLD_MS;
}

const IDLE_LINES = {
  warm: [
    "You alright there, {name}? You've been standing a while.",
    "Everything alright, {name}? You've gone quiet.",
    "Long day, {name}? The bench by my stall is free.",
  ],
  neutral: [
    "The street moves around you, {name}.",
    "Still here, {name}? Fair enough.",
    "The city's busy today, {name}. Good spot, that.",
  ],
  wry: [
    "{name}'s turned to stone. Someone fetch a sculptor.",
    "Blink twice if you're alive, {name}.",
    "Meditating, {name}? Or just stuck?",
  ],
  merchant: [
    "Take your time browsing, {name} — just say the word.",
    "Standing's free, {name}, but the goods are better. Have a look!",
    "Good spot for watching the market, {name}. Anything catch your eye?",
  ],
  // The gruff and the fearful don't check on anyone; they mutter to the
  // street itself. Deliberately no {name}: they're not talking to them.
  dismissive: [
    "Hmph. Human statue.",
    "Some people just... stand.",
    "Standing there won't pay the rent.",
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
 * Nudge voice for a citizen. The gruff and fearful mutter to the
 * street; merchants turn the nudge into a pitch; everyone else follows
 * warmth. Pure — unit-tested.
 */
function voiceOf(record) {
  const traits = new Set(record?.personality?.traits ?? []);
  for (const trait of traits) {
    if (DISMISSIVE_TRAITS.has(trait)) return "dismissive";
  }
  if (record?.merchantKind) return "merchant";
  return warmthOf(record?.personality);
}

/** Chebyshev distance between two tile objects, or Infinity off-plane. */
function tileDistance(a, b) {
  try {
    if (!a || !b || a.z !== b.z) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  } catch {
    return Infinity;
  }
}

/**
 * Online roster-backed citizens who can see the idle player.
 * Local-players-listed (like StreetSpectacle): the player is online and
 * their local list is live. Returns [{ record, bot, dist }].
 */
function nearbyIdlers(player, playerTile, nowMs = Date.now()) {
  let director = null;
  try {
    director = require("./director/CitizenDirector").getDirector();
  } catch {
    return [];
  }
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
    // The citizen is standing near the idle player, not across the city.
    let bx, by, bz;
    try {
      const loc = local.getLocation?.();
      if (!loc) continue;
      bx = loc.getX();
      by = loc.getY();
      bz = loc.getZ();
    } catch {
      continue;
    }
    const dist = tileDistance(playerTile, { x: bx, y: by, z: bz });
    if (dist > IDLE_RADIUS) continue;
    out.push({ record, bot: local, dist });
  }
  return out;
}

/**
 * A player tick fired: track their tile, and when a real player has
 * stood on the same tile for ten minutes, let the nearest eligible
 * citizen comment. Tick-gated to every 30 seconds; the per-tick cost is
 * a single timestamp subtraction.
 */
function onIdleSeen(event, nowMs = Date.now()) {
  const { player } = event ?? {};
  // Guard: citizen bots standing still are not AFK players.
  if (!isRealPlayer(player)) return;
  if (nowMs - lastIdleEvalAt < IDLE_EVAL_INTERVAL_MS) return;
  lastIdleEvalAt = nowMs;
  pruneIdleState(nowMs);

  let tile = null;
  try {
    const loc = player.getLocation?.();
    if (loc) tile = { x: loc.getX(), y: loc.getY(), z: loc.getZ() };
  } catch {
    return;
  }
  if (!tile) return;

  const playerName = player.getUsername?.() ?? "traveller";
  const entry = idleWatch.get(playerName);
  if (!entry) {
    // First sighting: start measuring this still spell from scratch.
    idleWatch.set(playerName, { ...tile, sinceMs: nowMs, nudged: false });
    return;
  }
  if (!sameTile(entry, tile)) {
    // Moved: drop the tracking so the next still spell starts fresh.
    idleWatch.delete(playerName);
    return;
  }
  if (entry.nudged) return; // already commented; wait for them to move
  if (!isAfk(entry, nowMs)) return;

  const playerGate = lastNudgeForPlayer.get(playerName) ?? 0;
  if (nowMs - playerGate < IDLE_PLAYER_COOLDOWN_MS) return;

  const candidates = nearbyIdlers(player, tile, nowMs).filter(({ record }) => {
    const username = record.username;
    if (
      nowMs - (lastNudgeByCitizen.get(username) ?? 0) <
      IDLE_CITIZEN_COOLDOWN_MS
    )
      return false;
    // Sociable citizens speak; quiet ones usually keep it to themselves.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    return chance(Math.random, IDLE_CHANCE * sociability);
  });
  if (candidates.length === 0) return;

  // Nearest pick: the closest citizen is the one who noticed them go still.
  candidates.sort((a, b) => a.dist - b.dist);
  const { record, bot } = candidates[0];
  const username = record.username;
  entry.nudged = true;
  lastNudgeByCitizen.set(username, nowMs);
  lastNudgeForPlayer.set(playerName, nowMs);

  const voice = voiceOf(record);
  const line = fillLine(pick(IDLE_LINES[voice] ?? IDLE_LINES.neutral), {
    name: playerName,
  });
  try {
    bot.forceChat?.(line.slice(0, 120));
  } catch {
    // A silent citizen.
  }

  // Remember it: they watched the player stand still. Neutral tone —
  // going quiet is neither friendly nor hostile.
  try {
    const memory = getMemory();
    memory.recordMeeting(username, playerName);
    memory.recordTone(username, playerName, 0);
  } catch {
    // Memory must never break the nudge.
  }
}

/**
 * A player logged out: drop their idle-tracking state so a relog
 * starts fresh. Attach-only partner to onIdleSeen.
 */
function clearIdleOnLogout(event) {
  try {
    const player = event?.player;
    const name = player?.getUsername?.();
    if (name) idleWatch.delete(name);
  } catch {
    // Tracking cleanup must never break logout.
  }
}

module.exports = {
  onIdleSeen,
  clearIdleOnLogout,
  // Pure helpers for the unit test.
  sameTile,
  isAfk,
  voiceOf,
  fillLine,
  IDLE_LINES,
  IDLE_AFK_THRESHOLD_MS,
  // Test-only state reset (maps + tick gate + prune gate).
  _resetStateForTests() {
    idleWatch.clear();
    lastNudgeByCitizen.clear();
    lastNudgeForPlayer.clear();
    lastIdleEvalAt = 0;
    lastIdlePruneAt = 0;
  },
};
