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
 * Zero LLM. Pure packet math. Tick-safe (every engine read wrapped).
 */

const CHAT_MAX_LEN = 80; // matches ChatPacketListener.handleText slice(0, 80)
const CHATBOX_MIN_GAP_MS = 8000;

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

/**
 * Speak like a player: overhead text + chat-box line for nearby real players.
 * @param {object} citizen - the speaking citizen's Player object
 * @param {string} text - what to say (sliced to 80 chars like real chat)
 * @param {object} [opts] - { bypassThrottle?: boolean }
 * @returns {boolean} true if the line reached at least one chat box
 */
function sayPublic(citizen, text, opts = {}) {
  if (!citizen || text == null) return false;
  // Mirror the real path: strip angle brackets (client tags), trim, 80 chars.
  const clean = String(text).replace(/[<>]/g, "").trim().slice(0, CHAT_MAX_LEN);
  if (!clean) return false;

  const nowMs = Date.now();
  pruneThrottle(nowMs);

  // Overhead for everyone nearby — the existing visible behavior, unchanged.
  try {
    citizen.forceChat?.(clean);
  } catch {
    // If overhead fails, the chat box likely will too. Continue anyway.
  }

  // Chat-box throttle: tighter than overhead. When throttled, the overhead
  // line above still showed — we just skip the box this time.
  const username = usernameOf(citizen);
  if (!opts.bypassThrottle && username) {
    const last = lastChatBoxAt.get(username) ?? 0;
    if (nowMs - last < CHATBOX_MIN_GAP_MS) return false;
  }

  const from = displayNameOf(citizen);
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
      recipient.getPacketSender().sendPublicChat(clean, from, speakerIndex);
      sent += 1;
    } catch {
      // One broken recipient doesn't stop the rest.
    }
  }

  if (sent > 0 && username) {
    lastChatBoxAt.set(username, nowMs);
  }
  // DIAG: log why chat-box delivery fails
  if (sent === 0 && !global._sayPublicDiagLogged) {
    global._sayPublicDiagLogged = true;
    const localCount = (locals || []).length;
    const realCount = (locals || []).filter(isRealPlayer).length;
    console.log(`[DIAG-SAYPUBLIC] sent=0, locals=${localCount}, realPlayers=${realCount}, from=${from}`);
  }
  return sent > 0;
}

/** Test seam: clear throttle state. */
function resetForTests() {
  lastChatBoxAt.clear();
  lastPruneAt = 0;
}

module.exports = {
  sayPublic,
  displayNameOf,
  isRealPlayer,
  resetForTests,
  CHAT_MAX_LEN,
  CHATBOX_MIN_GAP_MS,
};
