"use strict";

/**
 * CitizenRelationships — the foreground social-bond layer for AI citizens.
 *
 * CitizenMemory remembers facts; CitizenBonds holds the graph; this module
 * makes friendships *felt*: citizens light up when a friend logs in, miss
 * them when they leave, greet them by name when they pass, and warn their
 * own friends about players who wronged them.
 *
 * Data tier, zero LLM. Everything here is bounded (cooldowns per pair),
 * defensive (try/catch around every player touch), and plain-node testable:
 * CitizenRelationships.test.js.
 */

const { getMemory } = require("./CitizenMemory");
const { isFriend, bonds } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


const GREET_FRIEND_COOLDOWN_MS = 20 * 60 * 1000; // a friend is hailed at most every 20 min
const GREET_NEARBY_TILES = 12;
const TICK_GREET_CHANCE = 0.15;

const lastGreetAt = new Map(); // "citizenKey>playerKey" -> timestamp

function pairKey(citizenName, playerName) {
  return `${String(citizenName).toLowerCase()}>${String(playerName).toLowerCase()}`;
}

function canGreet(citizenName, playerName, now = Date.now()) {
  return now - (lastGreetAt.get(pairKey(citizenName, playerName)) ?? 0) >= GREET_FRIEND_COOLDOWN_MS;
}

function stampGreet(citizenName, playerName, now = Date.now()) {
  lastGreetAt.set(pairKey(citizenName, playerName), now);
  // Bound the map: drop entries older than a day.
  if (lastGreetAt.size > 2000) {
    const cutoff = now - 24 * 3600 * 1000;
    for (const [k, at] of lastGreetAt) {
      if (at < cutoff) lastGreetAt.delete(k);
    }
  }
}

function normalizeName(name) {
  return String(name ?? "").toLowerCase().trim();
}

function displayOf(record) {
  return record?.displayName ?? record?.username ?? "someone";
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

function notifyPlayer(player, message) {
  try {
    player?.sendMessage?.(message);
  } catch {
    // Non-fatal.
  }
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

/**
 * A friend logged in. Every online citizen who counts this player as a
 * friend lights up: a warm notify if the player can see it, and a journal
 * line ("reunited with X") so the LLM answers "how have you been?"
 * truthfully. Only citizens actually online react — the data tier already
 * knows they were apart.
 */
function onFriendLogin(director, player, now = Date.now()) {
  if (!director?.roster || !player) return 0;
  const playerName = player.getUsername?.();
  if (!playerName) return 0;
  let greeted = 0;
  for (const record of director.roster.values()) {
    if (!director.isOnline?.(record)) continue;
    let friend = false;
    try {
      friend = isFriend(record.username, playerName);
    } catch {
      continue;
    }
    if (!friend) continue;
    const name = displayOf(record);
    try {
      getMemory().recordMeeting(record.username, playerName, now);
    } catch {
      // Meeting must never break the greeting.
    }
    journalEvent(record.username, `Reunited with ${playerName} — they're back!`, "social");
    notifyPlayer(player, `${name} lights up: "${playerName}! You're back — I missed you."`);
    greeted += 1;
    if (greeted >= 5) break; // a crowd, not a mob
  }
  return greeted;
}

/**
 * A friend logged out. Their citizen friends notice the absence and miss
 * them — journaled, so "where's Aldric?" has a true answer tomorrow.
 */
function onFriendLogout(director, player, now = Date.now()) {
  if (!director?.roster || !player) return 0;
  const playerName = player.getUsername?.();
  if (!playerName) return 0;
  let missed = 0;
  for (const record of director.roster.values()) {
    if (!director.isOnline?.(record)) continue;
    let friend = false;
    try {
      friend = isFriend(record.username, playerName);
    } catch {
      continue;
    }
    if (!friend) continue;
    journalEvent(record.username, `${playerName} left. I'll miss them.`, "social");
    missed += 1;
  }
  return missed;
}

/**
 * Warn a citizen's own friends about a player who wronged them. Grudge
 * gossip already spreads by proximity; this is the personal channel — "I
 * don't trust them, and neither should you." Bounded: at most two friends,
 * only on real offenses (severity >= 2).
 */
function warnFriends(citizenName, playerName, kind, severity = 1, now = Date.now()) {
  if (severity < 2) return 0;
  let warned = 0;
  try {
    const friends = bonds(citizenName).friends ?? [];
    const memory = getMemory();
    for (const friendKey of friends.slice(0, 2)) {
      memory.heardAbout(friendKey, playerName, kind ?? "attack", severity, now);
      journalEvent(
        citizenName,
        `Warned ${friendKey} about ${playerName}. They should watch out.`,
        "social"
      );
      warned += 1;
    }
  } catch {
    // Warnings must never break the offense path.
  }
  return warned;
}

/** Real (non-bot) players near a citizen's bot. */
function nearbyRealPlayers(bot) {
  const out = [];
  try {
    for (const local of bot.getLocalPlayers?.() ?? []) {
      if (local !== bot && isRealPlayer(local)) out.push(local);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/**
 * Per-tick: citizens notice friend players nearby and hail them by name —
 * seeking them out socially, not just standing there. Data-tier forceChat,
 * personality-gated (outgoing citizens hail more), long per-pair cooldown.
 * Called from the director tick; one bad citizen never breaks the tick.
 */
function tickRelationships(director, now = Date.now()) {
  if (!director?.roster) return;
  const rng = agentRng(`relate:${Math.floor(now / 60000)}`);
  for (const record of director.roster.values()) {
    try {
      if (!director.isOnline?.(record)) continue;
      const bot = director.getBot?.(record);
      if (!bot) continue;
      for (const player of nearbyRealPlayers(bot)) {
        const playerName = player.getUsername?.();
        if (!playerName) continue;
        if (!isFriend(record.username, playerName)) continue;
        if (!canGreet(record.username, playerName, now)) continue;
        // Personality gates it: the outgoing hail, the reserved nod.
        let sociability = 1;
        try {
          sociability = require("./humanizer").humanizerProfile(record.personality).sociability ?? 1;
        } catch {
          sociability = 1;
        }
        if (!chance(rng, TICK_GREET_CHANCE * sociability)) continue;
        stampGreet(record.username, playerName, now);
        getMemory().recordMeeting(record.username, playerName, now);
        const name = displayOf(record);
        const lines = [
          `${playerName}! Good to see you.`,
          `Well met, ${playerName}!`,
          `${playerName} — fancy meeting you here!`,
        ];
        { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [lines[Math.floor(rng() * lines.length)]] })); }
        journalEvent(record.username, `Hailed ${playerName} in passing.`, "social");
        void name;
        break; // one hail per citizen per tick
      }
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

/** Test seam: clear cooldown state. */
function resetForTests() {
  lastGreetAt.clear();
}

module.exports = {
  onFriendLogin,
  onFriendLogout,
  warnFriends,
  tickRelationships,
  resetForTests,
  GREET_FRIEND_COOLDOWN_MS,
};
