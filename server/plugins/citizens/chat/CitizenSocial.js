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
const { agentRng, chance } = require("../lib/humanizer");
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
        const rec = username ? director.roster.get(username) : null;
        if (!rec || !director.isOnline(rec)) continue;
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

module.exports = {
  initCitizenSocial,
  maybeSocialize,
  onSocialChatResponse,
};
