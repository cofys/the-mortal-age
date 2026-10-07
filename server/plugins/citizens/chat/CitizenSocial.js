"use strict";

/**
 * CitizenSocial — foreground citizen-to-citizen conversation.
 *
 * Jon's two-tier rule: "They don't need to literally be talking if no one
 * is near, but the data needs to say they were."
 *
 * The background tick (CitizenBackground) already logs "chatted with X" as
 * cheap data for every citizen pair. THIS module is the foreground: when a
 * REAL player is nearby to overhear, we spend lite-tier LLM to make the
 * conversation actually happen as dialogue. Otherwise we spend nothing —
 * the journal already says they talked.
 *
 * Threads: { id, a, b, turn, maxTurns, startedAt }
 *   - Opener via llm:speak-request (A speaks first to B).
 *   - Replies via llm:chat-request (tier "lite", threadId passthrough).
 *   - The Mouth speaks everything public — nearby players overhear.
 *   - Caps: MAX_TURNS per thread, MAX_THREADS concurrent, per-citizen
 *     starter cooldown. Quota-safe by construction.
 */

const { getMemory } = require("../lib/CitizenMemory");
const { buildContext } = require("./CitizenContext");
const { agentRng, chance, humanizerProfile } = require("../lib/humanizer");
const {
  ACTIVITY_TAVERN_SOCIAL,
  ACTIVITY_LEISURE_STROLL,
  ACTIVITY_COURTIER_ATTEND,
  EVENT_LLM_CHAT_REQUEST,
} = require("../constants");

const SOCIAL_ACTIVITIES = new Set([
  ACTIVITY_TAVERN_SOCIAL,
  ACTIVITY_LEISURE_STROLL,
  ACTIVITY_COURTIER_ATTEND,
]);

const MAX_TURNS = 4; // opener + up to 3 replies, then it ends naturally
const MAX_THREADS = 8; // concurrent foreground conversations, world-wide
const STARTER_COOLDOWN_MS = 30 * 60 * 1000; // a citizen starts a chat at most every 30 min
const OVERHEAR_RADIUS = 18; // a real player within this many tiles makes it "worth" LLM
const TICK_CHANCE = 0.10; // per eligible citizen per ~60s tick

// --- unprompted greetings: citizens notice real players ---------------------
// A citizen with a real player nearby sometimes speaks FIRST to the player:
// a greeting, a comment, a reaction. Same two-tier rule — only when the
// player is actually there to hear it. Quota-safe: long cooldowns, few per
// tick, lite tier.
const GREET_RADIUS = 10; // tiles — close enough to actually talk to
const GREET_TICK_CHANCE = 0.06; // per eligible citizen per ~60s tick
const GREET_CITIZEN_COOLDOWN_MS = 20 * 60 * 1000; // a citizen greets at most every 20 min
const GREET_PLAYER_COOLDOWN_MS = 5 * 60 * 1000; // a player is greeted at most every 5 min
const MAX_GREETS_PER_TICK = 2;
const lastGreetAt = new Map(); // citizen username -> timestamp
const lastGreetedPlayerAt = new Map(); // player name -> timestamp

let pluginApi = null;
const threads = new Map(); // threadId -> { a, b, turn, maxTurns, startedAt }
const lastStartedAt = new Map(); // username -> timestamp
let threadSeq = 0;

function initCitizenSocial(api) {
  pluginApi = api;
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

/** A real player within overhear radius of the bot? */
function playerNearby(bot) {
  try {
    for (const local of bot.getLocalPlayers?.() ?? []) {
      if (local !== bot && isRealPlayer(local)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/** What A remembers about B, in one line for the opener prompt. */
function memoryLine(citizenA, citizenB) {
  try {
    const memory = getMemory();
    const entry = memory.getEntry(citizenA, citizenB);
    if (!entry || entry.met === 0) return "You've never spoken before.";
    const standing = memory.standing(citizenA, citizenB);
    const bits = [`You've spoken ${entry.met}x before.`];
    if (standing === "favorite" || standing === "warm") bits.push("You're fond of them.");
    else if (standing === "hostile") bits.push("You can't stand them — be sharp.");
    else if (standing === "cold") bits.push("You're wary of them.");
    else if (standing === "regular") bits.push("You know them well.");
    return bits.join(" ");
  } catch {
    return "";
  }
}

/**
 * Called on the director tick. Picks at most a couple of eligible citizens
 * and, if a real player is near to overhear, starts a foreground thread.
 * Everything else already happened as background data — this is pure bonus.
 */
function maybeSocialize(director, nowMs = Date.now()) {
  if (!pluginApi || !director) return;
  if (threads.size >= MAX_THREADS) return;

  // Prune dead threads (no response in 3 minutes — LLM down or quota out).
  for (const [id, thread] of threads) {
    if (nowMs - thread.startedAt > 3 * 60 * 1000) threads.delete(id);
  }

  const rng = agentRng(`social:${Math.floor(nowMs / 60000)}`);
  const eligible = [];
  for (const record of director.roster.values()) {
    if (!SOCIAL_ACTIVITIES.has(record.currentActivityId)) continue;
    if (!director.isOnline(record)) continue;
    if (nowMs - (lastStartedAt.get(record.username) ?? 0) < STARTER_COOLDOWN_MS) continue;
    if (!chance(rng, TICK_CHANCE)) continue;
    eligible.push(record);
    if (eligible.length >= 3) break; // a few starters per tick, max
  }

  for (const record of eligible) {
    if (threads.size >= MAX_THREADS) break;
    const botA = director.getBot(record);
    if (!botA) continue;
    // Jon's rule: no player nearby → no LLM. The journal already says they talked.
    if (!playerNearby(botA)) continue;

    // Find a nearby citizen to talk to.
    let botB = null;
    let recordB = null;
    try {
      const locA = botA.getLocation?.();
      for (const local of botA.getLocalPlayers?.() ?? []) {
        if (local === botA || isRealPlayer(local)) continue;
        const username = local.getUsername?.();
        const { normalizeName } = require("../lib/CitizenBonds");
        const rec = username ? director.roster.get(normalizeName(username)) : null;
        if (!rec || !director.isOnline(rec)) continue;
        // Open feuds get the cold shoulder: they don't chat, they glare.
        try {
          const { isOpenFeud } = require("../lib/CitizenKinship");
          if (isOpenFeud(record.username, rec.username)) continue;
        } catch {
          // Kinship must never break social.
        }
        botB = local;
        recordB = rec;
        break;
      }
      void locA;
    } catch {
      continue;
    }
    if (!botB || !recordB) continue;

    // Start the thread.
    const threadId = `social-${++threadSeq}-${nowMs}`;
    threads.set(threadId, {
      a: record.username,
      b: recordB.username,
      turn: 0,
      maxTurns: 2 + Math.floor(rng() * 3), // 2-4 turns
      startedAt: nowMs,
    });
    lastStartedAt.set(record.username, nowMs);

    try {
      const memory = getMemory();
      memory.recordMeeting(record.username, recordB.username);
      memory.recordMeeting(recordB.username, record.username);
    } catch {
      // Memory must never break social.
    }

    pluginApi.emitCustomEvent("llm:speak-request", {
      citizenUsername: record.username,
      toUsername: recordB.personality?.name ?? recordB.username,
      toRole: recordB.role,
      toMemory: memoryLine(record.username, recordB.username),
      context: buildContext(record.username, recordB.username),
      threadId,
    });
    pluginApi.log?.("[citizens] foreground thread started", {
      thread: threadId,
      a: record.username,
      b: recordB.username,
    });
  }
}

/**
 * Continue a thread when the gateway answers. Wired to llm:chat-response in
 * the plugin register. Only threads WE started (threadId present) continue;
 * player conversations are untouched.
 */
function onSocialChatResponse(payload) {
  const threadId = payload?.threadId;
  if (!threadId || !threads.has(threadId)) return;
  const thread = threads.get(threadId);
  thread.turn += 1;

  // Natural endings: max turns, or a coin flip (conversations trail off).
  if (thread.turn >= thread.maxTurns || Math.random() < 0.25) {
    threads.delete(threadId);
    return;
  }

  // Other party replies. Turn 0 was A's opener → B replies; then alternate.
  const replier = thread.turn % 2 === 1 ? thread.b : thread.a;
  const speaker = thread.turn % 2 === 1 ? thread.a : thread.b;

  pluginApi?.emitCustomEvent(EVENT_LLM_CHAT_REQUEST, {
    citizenUsername: replier,
    requesterUsername: speaker,
    text: String(payload.text ?? "").slice(0, 320),
    channel: "public",
    tier: "lite", // citizen chatter never touches flagship/standard
    context: buildContext(replier, speaker),
    threadId,
  });
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

/** A player mid-fight doesn't want small talk. */
function playerBusy(player) {
  try {
    if (player.inCombat?.() === true) return true;
    if (player.busy?.() === true) return true;
  } catch {
    // Assume free on error — a missed greet is worse than a mistimed one.
  }
  return false;
}

/**
 * What a citizen can see about a player at a glance: gear and bearing.
 * Defensive — anything that throws just yields "a traveler".
 */
function gearNote(player) {
  try {
    const equipment = player.getEquipment?.();
    const items = equipment?.getItems?.() ?? [];
    let worn = 0;
    let weaponName = null;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const id = item?.getId?.() ?? item?.id ?? null;
      if (Number.isInteger(id) && id > 0) {
        worn += 1;
        if (i === 3 && weaponName === null) {
          // Weapon slot — the most visible thing a person carries.
          try {
            weaponName =
              pluginApi?.core?.ItemDefinition?.forId?.(id)?.getName?.() ?? null;
          } catch {
            weaponName = null;
          }
        }
      }
    }
    if (weaponName) return `They carry a ${String(weaponName).toLowerCase()}.`;
    if (worn >= 6) return "They're well-armed and armored.";
    if (worn >= 3) return "They're geared for the road.";
    if (worn >= 1) return "They're lightly geared.";
    return "They're traveling light.";
  } catch {
    return "They're a traveler passing through.";
  }
}

/**
 * Unprompted greetings: citizens notice real players and sometimes speak
 * first — a greeting, a comment on the day, a reaction to the player's
 * gear. Called on the director tick, right after maybeSocialize.
 *
 * Jon's two-tier rule applies: only when the player is actually there.
 * Personality gates it — nervous/guarded citizens almost never initiate,
 * warm/chatty ones do. Long cooldowns keep it rare and quota-safe.
 */
function maybeGreetPlayer(director, nowMs = Date.now()) {
  if (!pluginApi || !director) return;
  const rng = agentRng(`greet:${Math.floor(nowMs / 60000)}`);
  let greets = 0;

  for (const record of director.roster.values()) {
    if (greets >= MAX_GREETS_PER_TICK) break;
    if (!director.isOnline(record)) continue;
    if (nowMs - (lastGreetAt.get(record.username) ?? 0) < GREET_CITIZEN_COOLDOWN_MS) continue;

    // Personality gates initiation: the bold greet, the nervous don't.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    if (!chance(rng, GREET_TICK_CHANCE * sociability)) continue;

    const bot = director.getBot(record);
    if (!bot) continue;

    // Nearest real player in talking range.
    let target = null;
    try {
      for (const local of bot.getLocalPlayers?.() ?? []) {
        if (local === bot || !isRealPlayer(local)) continue;
        if (!withinTiles(bot, local, GREET_RADIUS)) continue;
        if (playerBusy(local)) continue;
        const name = local.getUsername?.();
        if (!name) continue;
        if (nowMs - (lastGreetedPlayerAt.get(name) ?? 0) < GREET_PLAYER_COOLDOWN_MS) continue;
        target = local;
        break;
      }
    } catch {
      continue;
    }
    if (!target) continue;

    const playerName = target.getUsername();
    lastGreetAt.set(record.username, nowMs);
    lastGreetedPlayerAt.set(playerName, nowMs);
    greets += 1;

    try {
      const memory = getMemory();
      memory.recordMeeting(record.username, playerName);
    } catch {
      // Memory must never break greetings.
    }

    pluginApi.emitCustomEvent("llm:speak-request", {
      citizenUsername: record.username,
      toKind: "player",
      toUsername: playerName,
      toRole: "traveler",
      toMemory: memoryLine(record.username, playerName),
      playerNote: gearNote(target),
      context: buildContext(record.username, playerName),
    });
    pluginApi.log?.("[citizens] greeted player", {
      citizen: record.username,
      player: playerName,
    });
  }
}

module.exports = {
  initCitizenSocial,
  maybeSocialize,
  maybeGreetPlayer,
  onSocialChatResponse,
};
