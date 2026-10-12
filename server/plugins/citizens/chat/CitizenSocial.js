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
const GREET_TICK_CHANCE = 0.12; // per eligible citizen per ~60s tick (raised 2026-10-11: Jon walks through 20 citizens and hears nothing)
const GREET_CITIZEN_COOLDOWN_MS = 20 * 60 * 1000; // a citizen greets at most every 20 min
const GREET_PLAYER_COOLDOWN_MS = 2 * 60 * 1000; // a player is greeted at most every 2 min (was 5: the per-player throttle, not the per-citizen one, was the binding constraint)
const MAX_GREETS_PER_TICK = 2;
const lastGreetAt = new Map(); // citizen username -> timestamp

// Cooldown entries for removed citizens would linger forever. Prune
// hourly. Memory-leak plug, 2026-10-07.
let lastGreetPruneAt = 0;
function pruneGreetCooldowns(nowMs) {
  if (nowMs - lastGreetPruneAt < 3600 * 1000) return;
  lastGreetPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastGreetAt) {
    if (at < cutoff) lastGreetAt.delete(k);
  }
  for (const [k, at] of lastNoticedAt) {
    if (at < cutoff) lastNoticedAt.delete(k);
  }
}
const lastGreetedPlayerAt = new Map(); // player name -> timestamp

// --- cheap acknowledgment: citizens NOTICE newcomers --------------------------
// The greet pass above speaks (LLM) to a player at most every 2 minutes.
// This pass is cheaper than speech: when a real player enters a citizen's
// radius and no greeting fires, the citizen turns to FACE them. Facing is
// visible and free — real players turn to look at newcomers. Gated to
// idle-ish citizens (not fighting, not mid-conversation); a ~2 min per
// citizen-per-player cooldown keeps a loiterer from being stared at forever.
// Data tier, zero LLM.
const NOTICE_RADIUS = 8; // tiles — close enough to notice a face
const NOTICE_TICK_CHANCE = 0.7; // per newly-arrived player per tick
const NOTICE_COOLDOWN_MS = 2 * 60 * 1000; // a citizen notices a player at most every 2 min
const lastNoticedAt = new Map(); // `${citizen}:${player}` -> timestamp

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
  // Perf (#4): shared online-only iteration (was a full roster scan with an
  // inline isOnline gate). Return false stops the scan once we have enough.
  director.forEachOnline((record) => {
    if (!SOCIAL_ACTIVITIES.has(record.currentActivityId)) return;
    if (nowMs - (lastStartedAt.get(record.username) ?? 0) < STARTER_COOLDOWN_MS) return;
    if (!chance(rng, TICK_CHANCE)) return;
    eligible.push(record);
    if (eligible.length >= 3) return false; // a few starters per tick, max
  });

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
  pruneGreetCooldowns(nowMs);
  const rng = agentRng(`greet:${Math.floor(nowMs / 60000)}`);
  let greets = 0;
  const greetedThisTick = new Set(); // citizens already engaged — the notice/activity passes skip them

  // Perf (#4): shared online-only iteration (was a full roster scan with an
  // inline isOnline gate). Return false stops the scan at the greet cap.
  director.forEachOnline((record) => {
    if (greets >= MAX_GREETS_PER_TICK) return false;
    if (nowMs - (lastGreetAt.get(record.username) ?? 0) < GREET_CITIZEN_COOLDOWN_MS) return;

    // Personality gates initiation: the bold greet, the nervous don't.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    if (!chance(rng, GREET_TICK_CHANCE * sociability)) return;

    const bot = director.getBot(record);
    if (!bot) return;

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
      return;
    }
    if (!target) return;

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
    greetedThisTick.add(record.username);
  });

  // The rest of the social-reactivity pass rides this tick slot (the
  // director calls maybeGreetPlayer on the slow tick; the director and
  // plugin wiring are sibling-owned, so everything chains from here):
  //   1. cheap acknowledgment — citizens who didn't greet still NOTICE
  //      newcomers by turning to face them;
  //   2. activity reactions — the street notices what players are DOING.
  maybeNoticePlayer(director, nowMs, greetedThisTick);
  try {
    require("../StreetActivity").tickActivityReactions(director, nowMs, greetedThisTick);
  } catch {
    // Activity reactions must never break greetings.
  }
}

/** The citizen is doing something a glance would interrupt. */
function citizenOccupied(record, bot) {
  try {
    if (bot.inCombat?.() === true) return true;
  } catch {
    // Fall through to the conversation check.
  }
  try {
    // Lazy require: CitizenConversations must finish loading before we
    // ask it anything (same pattern as CitizenHeardReactions).
    const { activeConversationFor } = require("./CitizenConversations");
    if (activeConversationFor(record.username) != null) return true;
  } catch {
    // Unknown is free — a missed glance beats a broken tick.
  }
  return false;
}

/**
 * Cheap acknowledgment: citizens notice newcomers. For each idle-ish
 * citizen, find real players in radius the citizen hasn't noticed in the
 * last ~2 minutes and turn to face them — the visible "I see you" that
 * real players give strangers. No LLM, no chat line: facing is free.
 *
 * excludedUsernames: citizens that greeted this tick (they're already
 * engaged — a glance on top would read as robotic).
 */
function maybeNoticePlayer(director, nowMs = Date.now(), excludedUsernames = new Set()) {
  if (!director) return;
  pruneGreetCooldowns(nowMs);
  const rng = agentRng(`notice:${Math.floor(nowMs / 60000)}`);

  // Perf (#4): shared online-only iteration (was a full roster scan with an
  // inline isOnline gate).
  director.forEachOnline((record) => {
    if (excludedUsernames.has(record.username)) return;
    const bot = director.getBot(record);
    if (!bot) return;
    if (citizenOccupied(record, bot)) return;

    // Nearest newcomer: a real player in radius the citizen hasn't
    // noticed recently. Busy players (mid-skill, mid-fight) get the
    // glance too — a look is not an interruption, and the greet pass
    // already skips them.
    let target = null;
    let targetName = null;
    let targetKey = null;
    try {
      for (const local of bot.getLocalPlayers?.() ?? []) {
        if (local === bot || !isRealPlayer(local)) continue;
        if (!withinTiles(bot, local, NOTICE_RADIUS)) continue;
        const name = local.getUsername?.();
        if (!name) continue;
        const key = `${record.username}:${name}`;
        if (nowMs - (lastNoticedAt.get(key) ?? 0) < NOTICE_COOLDOWN_MS) continue;
        target = local;
        targetName = name;
        targetKey = key;
        break;
      }
    } catch {
      return;
    }
    if (!target) return;

    // Personality gates the glance: the bold turn to look, the nervous
    // mostly don't — but everyone notices sometimes.
    let sociability = 1;
    try {
      sociability = humanizerProfile(record.personality).sociability ?? 1;
    } catch {
      sociability = 1;
    }
    if (!chance(rng, NOTICE_TICK_CHANCE * (0.4 + 0.6 * sociability))) return;

    try {
      // Lazy require: CitizenAlive owns the canonical faceToward (real
      // engine facing API). Top-level would risk a load cycle.
      const { faceToward } = require("../lib/CitizenAlive");
      const tile = target.getLocation?.();
      if (tile) {
        faceToward(bot, {
          x: tile.getX(),
          y: tile.getY(),
          z: tile.getZ?.() ?? 0,
        });
      }
    } catch {
      // Cosmetic.
    }
    lastNoticedAt.set(targetKey, nowMs);
    pluginApi?.log?.("[citizens] noticed player", {
      citizen: record.username,
      player: targetName,
    });
  });
}

/** Clear greet/notice cooldowns (tests). */
function resetForTests() {
  lastGreetAt.clear();
  lastGreetedPlayerAt.clear();
  lastNoticedAt.clear();
}

module.exports = {
  initCitizenSocial,
  maybeSocialize,
  maybeGreetPlayer,
  maybeNoticePlayer,
  onSocialChatResponse,
  // Test seams.
  resetForTests,
  _lastGreetAt: lastGreetAt,
  _lastNoticedAt: lastNoticedAt,
  // Tuned values, pinned by the test so a future edit can't silently
  // re-quieten the streets.
  _GREET_TICK_CHANCE: GREET_TICK_CHANCE,
  _GREET_PLAYER_COOLDOWN_MS: GREET_PLAYER_COOLDOWN_MS,
  _GREET_CITIZEN_COOLDOWN_MS: GREET_CITIZEN_COOLDOWN_MS,
  _NOTICE_RADIUS: NOTICE_RADIUS,
  _NOTICE_COOLDOWN_MS: NOTICE_COOLDOWN_MS,
};
