"use strict";

/**
 * CitizenSayPublic — citizen speech that lands in the chat box, not just overhead.
 *
 * Jon: "their talking doesn't go into the chat either, it just disappears
 * like an NPC." He was right. Citizen `forceChat` (Mobile.ts FORCED_CHAT flag)
 * only renders overhead text — nothing reaches any player's chat box.
 *
 * Real player chat (ChatPacketListener.handleText) does TWO things:
 *   1. player.forceChat(text) — overhead text for everyone nearby
 *   2. For each nearby recipient: recipient.getPacketSender().sendPublicChat(
 *        text, displayName, playerIndex) — the chat-box line
 *
 * sayPublic(citizen, text) mirrors that exactly, so citizens talk like players:
 * overhead + chat box. Citizens are full Player objects (getIndex,
 * getLocalPlayers, getPacketSender all real), so this works.
 *
 * LOOP GUARD (verified by code reading, not just asserted):
 * sayPublic sends packets DIRECTLY via recipient.getPacketSender().sendPublicChat.
 * It never calls PluginManager.emitSocialPacket, which is the ONLY entry to the
 * api.onSocialPacket -> citizens:chat-heard chain (that chain starts in
 * ChatPacketListener.handleText, i.e. real player keyboard input). A citizen
 * speaking via sayPublic therefore cannot re-trigger its own (or anyone's)
 * chat-heard reactions. The existing isCitizenBot(player) guard in
 * CitizenChat.onSocialPacket is belt-and-suspenders on top.
 *
 * Rate limits: the chat box is more visible than overhead. Each citizen gets
 * its own chat-box throttle (CHATBOX_MIN_GAP_MS). When throttled, speech falls
 * back to overhead-only rather than being dropped — the line still shows, it
 * just doesn't hit the box. Call sites keep their own (usually longer)
 * throttles; this is a safety net against 18 citizens flooding one box.
 *
 * Long utterances: instead of truncating mid-sentence at 80 chars, the text
 * is split into ≤80-char chunks at word boundaries and sent as follow-up
 * messages (like a real player typing a second line), capped at MAX_CHUNKS.
 * Continuations are spaced CHUNK_GAP_MS apart and are part of the same
 * utterance — they don't re-claim the throttle, but they refresh it so a new
 * message can't interleave mid-utterance.
 *
 * Zero LLM. Pure packet math. Tick-safe (every engine read wrapped).
 */

const CHAT_MAX_LEN = 80; // matches ChatPacketListener.handleText slice(0, 80)
const CHATBOX_MIN_GAP_MS = 8000;
const MAX_CHUNKS = 3; // 240 chars max per utterance; longer means upstream is wrong
const CHUNK_GAP_MS = CHATBOX_MIN_GAP_MS; // continuations read as typed follow-ups

/** username -> timestamp of last chat-box send (memory-leak plug below). */
const lastChatBoxAt = new Map();
let lastPruneAt = 0;

function pruneThrottle(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastChatBoxAt) {
    if (at < cutoff) lastChatBoxAt.delete(k);
  }
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

/** Mirrors ChatPacketListener.displayName: character name, else username. */
function displayNameOf(citizen) {
  try {
    const name = citizen.getAttribute?.("character:display-name");
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  } catch {
    // fall through
  }
  try {
    return citizen.getUsername?.() ?? "Someone";
  } catch {
    return "Someone";
  }
}

function usernameOf(citizen) {
  try {
    return citizen.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a leading self-name prefix ("Nessa Knot: " or "Nessa: ") from a line.
 * The chat box always renders the speaker's name, so a line that starts with
 * the citizen's own name reads doubled ("Nessa Knot: Nessa Knot: ...").
 * Matches the full display name and the first name, case-insensitively.
 * Returns the stripped line (trimmed), or "" if nothing remains.
 */
function stripSelfNamePrefix(text, displayName) {
  if (!text || !displayName) return String(text ?? "");
  const names = new Set();
  const full = String(displayName).trim();
  if (full) names.add(full);
  const first = full.split(/\s+/)[0];
  if (first && first !== full) names.add(first);
  let out = String(text);
  for (const name of names) {
    const re = new RegExp("^" + escapeRegExp(name) + "\\s*:\\s*", "i");
    const next = out.replace(re, "");
    if (next !== out) {
      out = next;
      break; // one strip is enough; don't cascade
    }
  }
  return out.trim();
}

/**
 * Split text into chunks of at most maxLen chars, breaking at word
 * boundaries. A single word longer than maxLen is hard-split.
 */
function splitChunks(text, maxLen) {
  const chunks = [];
  let rest = String(text).trim();
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen; // no space in range: hard-split a long word
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  return chunks;
}

/** Chunk scheduler: real setTimeout in prod, replaceable in tests. */
let chunkScheduler = (fn, ms) => setTimeout(fn, ms);

function scheduleChunk(fn, ms) {
  try {
    chunkScheduler(fn, ms);
  } catch {
    // Never let a scheduling failure kill the utterance.
  }
}

/** Test seam: replace the chunk scheduler (e.g. run continuations immediately). */
function setChunkScheduler(fn) {
  chunkScheduler = typeof fn === "function" ? fn : (f, ms) => setTimeout(f, ms);
}

/**
 * Deliver one chunk: overhead for everyone nearby + chat-box line for nearby
 * real players. Refreshes the sender's chat-box throttle timestamp so a new
 * utterance can't interleave with a multi-chunk one in flight.
 * @returns {boolean} true if the chunk reached at least one chat box
 */
function sendChunk(citizen, chunk, from, username, nowMs) {
  try {
    citizen.forceChat?.(chunk);
  } catch {
    // Overhead failing doesn't stop the chat box.
  }

  let speakerIndex = 0;
  try {
    speakerIndex = citizen.getIndex?.() ?? 0;
  } catch {
    // 0 is fine — the client still renders the line.
  }

  // Recipients: nearby real players only. Citizens have no client session,
  // so sending to them is pointless; isRealPlayer excludes them (and the
  // speaker, who is a bot). Dedup by index like the real path does.
  const seen = new Set();
  let sent = 0;
  let locals = [];
  try {
    locals = citizen.getLocalPlayers?.() ?? [];
  } catch {
    locals = [];
  }
  for (const recipient of locals) {
    if (!isRealPlayer(recipient)) continue;
    let idx = -1;
    try {
      idx = recipient.getIndex?.() ?? -1;
    } catch {
      continue;
    }
    if (idx < 0 || seen.has(idx)) continue;
    // Respect chat privacy, exactly like ChatPacketListener.handleText.
    try {
      if (!recipient.getRelations?.().canReceivePublicChatFrom?.(citizen)) continue;
    } catch {
      continue;
    }
    seen.add(idx);
    try {
      recipient.getPacketSender().sendPublicChat(chunk, from, speakerIndex);
      sent += 1;
    } catch {
      // One broken recipient doesn't stop the rest.
    }
  }

  if (sent > 0 && username) {
    lastChatBoxAt.set(username, nowMs);
  }
  return sent > 0;
}

/** Overhead-only fallback for all chunks, in turn (throttled path). */
function sendOverheadChunks(citizen, chunks) {
  try {
    citizen.forceChat?.(chunks[0]);
  } catch {
    return;
  }
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    scheduleChunk(() => {
      try {
        citizen.forceChat?.(chunk);
      } catch {
        // Citizen gone — nothing more to show.
      }
    }, i * CHUNK_GAP_MS);
  }
}

/**
 * Speak like a player: overhead text + chat-box line for nearby real players.
 * Long utterances are split into ≤80-char chunks at word boundaries and sent
 * as follow-up messages (like a real player typing a second line), capped at
 * MAX_CHUNKS. Continuations are part of the same utterance: they don't
 * re-claim the chat-box throttle, but they refresh it so a new message can't
 * interleave mid-utterance.
 * @param {object} citizen - the speaking citizen's Player object
 * @param {string} text - what to say
 * @param {object} [opts] - { bypassThrottle?: boolean }
 * @returns {boolean} true if the first chunk reached at least one chat box
 */
function sayPublic(citizen, text, opts = {}) {
  if (!citizen || text == null) return false;
  // Mirror the real path: strip angle brackets (client tags), trim.
  const clean = String(text).replace(/[<>]/g, "").trim();
  if (!clean) return false;

  const from = displayNameOf(citizen);
  // A citizen must never lead a public message with their own name: the chat
  // box always renders the speaker, so "Name: ..." text reads doubled.
  // Some template/LLM paths prefix the line anyway — strip it here.
  const line = stripSelfNamePrefix(clean, from);
  if (!line) return false;

  // Split before any length cap: no more mid-sentence truncation.
  const chunks = splitChunks(line, CHAT_MAX_LEN).slice(0, MAX_CHUNKS);

  const nowMs = Date.now();
  pruneThrottle(nowMs);

  // Chat-box throttle: tighter than overhead. When throttled, speech falls
  // back to overhead-only rather than being dropped — the line still shows,
  // it just doesn't hit the box.
  const username = usernameOf(citizen);
  const throttled =
    !opts.bypassThrottle &&
    !!username &&
    nowMs - (lastChatBoxAt.get(username) ?? 0) < CHATBOX_MIN_GAP_MS;
  if (throttled) {
    sendOverheadChunks(citizen, chunks);
    return false;
  }

  const sentFirst = sendChunk(citizen, chunks[0], from, username, nowMs);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    scheduleChunk(() => {
      const t = Date.now();
      pruneThrottle(t);
      sendChunk(citizen, chunk, from, username, t);
    }, i * CHUNK_GAP_MS);
  }
  return sentFirst;
}

/** Test seam: clear throttle state and reset the chunk scheduler. */
function resetForTests() {
  lastChatBoxAt.clear();
  lastPruneAt = 0;
  chunkScheduler = (fn, ms) => setTimeout(fn, ms);
}

module.exports = {
  sayPublic,
  displayNameOf,
  isRealPlayer,
  stripSelfNamePrefix,
  splitChunks,
  setChunkScheduler,
  resetForTests,
  CHAT_MAX_LEN,
  CHATBOX_MIN_GAP_MS,
  MAX_CHUNKS,
};
