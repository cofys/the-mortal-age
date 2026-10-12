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
 * VOICE BACKSTOP (2026-10-11): every citizen has a seeded voice profile
 * (lib/citizenVoice: register, lowercase, exclaim) derived from their
 * personality — but not every call site wires the pick through voiceLine.
 * This is the one choke point all speech funnels through, so sayPublic
 * applies the speaker's voice signature (case/punctuation) to the line
 * before it speaks. Pick-time styling via voiceLine is idempotent, so
 * already-wired call sites are unaffected; unwired ones now sound like
 * their speaker instead of the pool's default voice.
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
 * REPETITION GUARD (anti-repeat chatter): template pools are shared
 * server-wide, so without memory the same citizen repeats a line minutes
 * apart and a crowd chants "Morning!" in unison. Two memories, both fed by
 * every sayPublic call (the one choke point all speech funnels through):
 *   1. per-citizen: the last REPEAT_SELF_KEEP normalized lines per speaker;
 *   2. per-area: normalized lines said within REPEAT_AREA_TILES (chebyshev)
 *      in the last REPEAT_AREA_MS.
 * pickLineAvoidingRepeat(citizen, pickFn) wraps a template pick: it re-rolls
 * the pick up to REPEAT_RETRIES times while the rendered line matches either
 * memory, then accepts the last candidate anyway — repetition beats muteness.
 * The accepted pick is recorded as PENDING immediately, so a second citizen
 * picking in the same tick (or a typing-delayed reaction firing seconds
 * later) sees it before sayPublic commits it. Pending entries expire after
 * REPEAT_PENDING_MS; sayPublic converts a citizen's pending entry into a
 * committed one when the line actually speaks.
 *
 * Zero LLM. Pure packet math. Tick-safe (every engine read wrapped).
 */

const CHAT_MAX_LEN = 80; // matches ChatPacketListener.handleText slice(0, 80)
const CHATBOX_MIN_GAP_MS = 8000;
const MAX_CHUNKS = 3; // 240 chars max per utterance; longer means upstream is wrong
const CHUNK_GAP_MS = CHATBOX_MIN_GAP_MS; // continuations read as typed follow-ups

const { voiceFor, styleLine } = require("../lib/citizenVoice");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");

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

// ---------------------------------------------------------------------------
// Repetition guard — per-citizen + per-area recent-line memory.
// ---------------------------------------------------------------------------

const REPEAT_SELF_KEEP = 8; // normalized lines remembered per citizen
const REPEAT_AREA_TILES = 15; // chebyshev radius counting as "nearby"
const REPEAT_AREA_MS = 10 * 60 * 1000; // area memory window
const REPEAT_PENDING_MS = 30 * 1000; // accepted-pick reservation window
const REPEAT_RETRIES = 3; // re-roll attempts before accepting a repeat
const REPEAT_MAX_AREA = 2000; // cap on committed area entries
const REPEAT_MAX_PENDING = 500; // cap on pending pick reservations
const REPEAT_MAX_CITIZENS = 2000; // cap on per-citizen memory entries

/** username -> [{ key, at }] newest last (committed speech only). */
const recentSelfLines = new Map();
/** [{ key, x, y, at }] committed speech with a known tile. */
const recentAreaLines = [];
/** [{ username, key, x, y, at }] accepted-but-not-yet-spoken picks. */
const pendingPicks = [];
let lastRepeatPruneAt = 0;

/**
 * Normalize a line for repeat comparison: lowercase, the speaker's own name
 * tokens removed ("Nessa Knot: Morning!" and "Morning!" are the same line),
 * punctuation stripped, whitespace collapsed. Only the speaker's own name is
 * stripped — a line addressed to someone else ("hey Harold!") genuinely reads
 * differently from one addressed to Marta.
 */
function normalizeRepeatLine(text, displayName) {
  let out = String(text ?? "").toLowerCase();
  const full = String(displayName ?? "").trim().toLowerCase();
  if (full) {
    const tokens = new Set([full]);
    for (const w of full.split(/\s+/)) {
      // Tokens under 3 chars would eat real words ("Al" in "also").
      if (w.length >= 3) tokens.add(w);
    }
    for (const t of tokens) {
      out = out.replace(new RegExp("\\b" + escapeRegExp(t) + "\\b", "g"), " ");
    }
  }
  return out.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Defensive tile read (same shape as the botTile helpers elsewhere). */
function tileOf(citizen) {
  try {
    const loc = citizen?.getLocation?.() ?? citizen?.location ?? null;
    if (!loc) return null;
    const x = typeof loc.getX === "function" ? loc.getX() : loc.x;
    const y = typeof loc.getY === "function" ? loc.getY() : loc.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function chebyshevTiles(a, b) {
  if (!a || b == null || b.x == null || b.y == null) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * True when this normalized line is "recent": said by this citizen before,
 * reserved by a pick not yet spoken (own or a nearby citizen's), or said by
 * anyone within REPEAT_AREA_TILES in the last REPEAT_AREA_MS.
 */
function isRecentLine(username, key, tile, nowMs) {
  if (!key) return false;
  if (username) {
    const arr = recentSelfLines.get(username);
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].key === key) return true;
      }
    }
  }
  for (const p of pendingPicks) {
    if (p.key !== key || nowMs - p.at > REPEAT_PENDING_MS) continue;
    if (username && p.username === username) return true;
    if (tile && chebyshevTiles(tile, p) <= REPEAT_AREA_TILES) return true;
  }
  if (tile) {
    for (let i = recentAreaLines.length - 1; i >= 0; i--) {
      const e = recentAreaLines[i];
      if (e.key !== key || nowMs - e.at > REPEAT_AREA_MS) continue;
      if (chebyshevTiles(tile, e) <= REPEAT_AREA_TILES) return true;
    }
  }
  return false;
}

/**
 * Commit a spoken line to both memories. Called by sayPublic for EVERY line
 * that speaks — whichever module picked it (or none: LLM lines count too, so
 * a template never echoes something just said). Supersedes the pick-time
 * pending reservation for the same citizen+line.
 */
function recordCommittedLine(citizen, text, nowMs) {
  const username = usernameOf(citizen);
  const key = normalizeRepeatLine(text, displayNameOf(citizen));
  if (!key) return;
  const tile = tileOf(citizen);
  for (let i = pendingPicks.length - 1; i >= 0; i--) {
    const p = pendingPicks[i];
    if (p.username === username && p.key === key) pendingPicks.splice(i, 1);
  }
  if (username) {
    const isNew = !recentSelfLines.has(username);
    let arr = recentSelfLines.get(username);
    if (!arr) {
      arr = [];
      recentSelfLines.set(username, arr);
    }
    const last = arr[arr.length - 1];
    if (last && last.key === key) last.at = nowMs;
    else {
      arr.push({ key, at: nowMs });
      while (arr.length > REPEAT_SELF_KEEP) arr.shift();
    }
    // Eager backstop cap (the hourly prune below only expires entries).
    // A new key lands last in insertion order, so evicting the oldest key
    // never evicts the citizen just recorded.
    if (isNew && recentSelfLines.size > REPEAT_MAX_CITIZENS) {
      recentSelfLines.delete(recentSelfLines.keys().next().value);
    }
  }
  if (tile) {
    recentAreaLines.push({ key, x: tile.x, y: tile.y, at: nowMs });
    if (recentAreaLines.length > REPEAT_MAX_AREA) {
      recentAreaLines.splice(0, recentAreaLines.length - REPEAT_MAX_AREA);
    }
  }
  pruneRepeatGuard(nowMs);
}

function pruneRepeatGuard(nowMs) {
  if (nowMs - lastRepeatPruneAt < 3600 * 1000) return;
  lastRepeatPruneAt = nowMs;
  for (let i = recentAreaLines.length - 1; i >= 0; i--) {
    if (nowMs - recentAreaLines[i].at > REPEAT_AREA_MS) recentAreaLines.splice(i, 1);
  }
  for (let i = pendingPicks.length - 1; i >= 0; i--) {
    if (nowMs - pendingPicks[i].at > REPEAT_PENDING_MS) pendingPicks.splice(i, 1);
  }
  const selfCutoff = nowMs - 24 * 3600 * 1000;
  for (const [user, arr] of recentSelfLines) {
    const last = arr[arr.length - 1];
    if (!last || nowMs - last.at > selfCutoff) recentSelfLines.delete(user);
  }
  let over = recentSelfLines.size - REPEAT_MAX_CITIZENS;
  if (over > 0) {
    for (const user of recentSelfLines.keys()) {
      recentSelfLines.delete(user);
      if (--over <= 0) break;
    }
  }
}

/**
 * Pick a template line with repetition avoidance. Renders pickFn() up to
 * REPEAT_RETRIES+1 times, re-rolling while the rendered line matches the
 * citizen's or the area's recent speech. When every retry hits a recent
 * line, the last candidate is returned anyway — repetition beats muteness.
 * A null/empty pick passes straight through (pool miss: the caller, not the
 * guard, decides the silence).
 *
 * The accepted pick is recorded as PENDING immediately, so a second citizen
 * picking in the same tick — or a typing-delayed reaction firing seconds
 * later — sees it before sayPublic commits it.
 *
 * @param {object|null} citizen - the speaking citizen's Player object
 * @param {function} pickFn - () => rendered line (or null)
 * @param {object} [opts] - { retries?: number }
 * @returns {string|null} the accepted line
 */
function pickLineAvoidingRepeat(citizen, pickFn, opts = {}) {
  if (typeof pickFn !== "function") return null;
  if (!citizen) {
    try {
      return pickFn();
    } catch {
      return null;
    }
  }
  const retries = Number.isFinite(opts.retries)
    ? Math.max(0, opts.retries | 0)
    : REPEAT_RETRIES;
  const username = usernameOf(citizen);
  const displayName = displayNameOf(citizen);
  const tile = tileOf(citizen);
  const nowMs = Date.now();
  let line = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let candidate = null;
    try {
      candidate = pickFn();
    } catch {
      candidate = null;
    }
    if (!candidate) return candidate;
    line = candidate;
    if (!isRecentLine(username, normalizeRepeatLine(candidate, displayName), tile, nowMs)) {
      break;
    }
  }
  if (username) {
    const key = normalizeRepeatLine(line, displayName);
    if (key) {
      pendingPicks.push({
        username,
        key,
        x: tile ? tile.x : null,
        y: tile ? tile.y : null,
        at: nowMs,
      });
      if (pendingPicks.length > REPEAT_MAX_PENDING) {
        pendingPicks.splice(0, pendingPicks.length - REPEAT_MAX_PENDING);
      }
    }
  }
  return line;
}

/** Test seam: repeat-guard store sizes (caps/prune assertions). */
function repeatGuardStats() {
  return {
    citizens: recentSelfLines.size,
    area: recentAreaLines.length,
    pending: pendingPicks.length,
  };
}

/**
 * Voice backstop: apply the speaker's own voice signature (case/punctuation
 * per lib/citizenVoice) to a line about to speak. Call sites that already
 * picked through voiceLine get this transform twice — styleLine is
 * idempotent, so that's a no-op. Call sites that picked a raw template line
 * get the speaker's signature applied here instead of the pool's default.
 * A missing/broken personality attribute degrades to the line unchanged:
 * speech must never break on a voice lookup.
 */
function applyVoiceStyle(citizen, line) {
  try {
    const personality = citizen?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    const styled = styleLine(voiceFor(personality), String(line ?? ""));
    return styled.length > 0 ? styled : String(line ?? "");
  } catch {
    return String(line ?? "");
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

  // Voice backstop: the line speaks in the citizen's own voice, whichever
  // call site picked it. Applied before chunking so every chunk carries it.
  const voiced = applyVoiceStyle(citizen, line);
  if (!voiced) return false;

  // Split before any length cap: no more mid-sentence truncation.
  const chunks = splitChunks(voiced, CHAT_MAX_LEN).slice(0, MAX_CHUNKS);

  const nowMs = Date.now();
  pruneThrottle(nowMs);

  // Feed the repetition guard: every spoken line lands in the per-citizen
  // and per-area memories, whichever module picked it (or none — LLM lines
  // count too, so a template never echoes something just said).
  recordCommittedLine(citizen, voiced, nowMs);

  // Chat-box throttle: when throttled, the citizen stays silent entirely.
  // Previously overhead was sent without chatbox, which confused players
  // (bubbles visible but chatbox empty). Now throttled = no visible speech,
  // keeping overhead and chatbox in sync.
  const username = usernameOf(citizen);
  const throttled =
    !opts.bypassThrottle &&
    !!username &&
    nowMs - (lastChatBoxAt.get(username) ?? 0) < CHATBOX_MIN_GAP_MS;
  if (throttled) {
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

/** Test seam: clear throttle + repeat-guard state, reset the chunk scheduler. */
function resetForTests() {
  lastChatBoxAt.clear();
  lastPruneAt = 0;
  recentSelfLines.clear();
  recentAreaLines.length = 0;
  pendingPicks.length = 0;
  lastRepeatPruneAt = 0;
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
  pickLineAvoidingRepeat,
  normalizeRepeatLine,
  repeatGuardStats,
  applyVoiceStyle,
  CHAT_MAX_LEN,
  CHATBOX_MIN_GAP_MS,
  MAX_CHUNKS,
  REPEAT_SELF_KEEP,
  REPEAT_AREA_TILES,
  REPEAT_AREA_MS,
  REPEAT_RETRIES,
};
