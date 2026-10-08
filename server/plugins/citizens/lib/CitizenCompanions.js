"use strict";

/**
 * CitizenCompanions — citizens invite players on personal outings.
 *
 * WHAT IT DOES (data tier, free):
 *   Citizens with no pending companion invite occasionally pick a nearby
 *   real player and invite them on a 1-on-1 outing: a fishing trip, a
 *   dungeon run, a walk, or a tavern drink. The invite goes through the
 *   existing CitizenBonds invite system (kind "companion_invite").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   A forceChat invitation line. The player says "yes" to accept or "no"
 *   to decline (existing chat-keyword path). On accept the citizen follows
 *   the player; on decline/ignore the citizen remembers.
 *
 * MEMORY (the point of this module):
 *   Every outcome is recorded in CitizenMemory via recordMoment:
 *     - accepted: MOMENT_HELPED "joined me for a <activity>"
 *     - declined: MOMENT_MET "turned down my <activity> invitation"
 *     - ignored:  MOMENT_MET "ignored my <activity> invitation"
 *   Invitation lines are flavored by history: citizens who've been
 *   turned down a lot sound wistful; regular companions sound warm.
 *
 * Zero LLM: invitation lines are scripted pools; memory is data.
 * Cooldown: one companion invite per citizen per 2 hours (not spammy).
 *
 * Wired into the director proximity tick next to the other social
 * features. Plain-node testable: CitizenCompanions.test.js.
 */

const {
  sendInvite,
  getInvites,
  resolveInvite,
  setFollow,
  normalizeName,
} = require("./CitizenBonds");
const { getMemory, MOMENT_HELPED, MOMENT_MET } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");

// === Tuning: all magic numbers here ===
const INVITE_COMPANION = "companion_invite";
const COMPANION_RADIUS = 12; // tiles — close enough for a personal invite
const COMPANION_CITIZEN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // one invite per citizen per 2h
const COMPANION_CHANCE = 0.15; // per eligible citizen per ~10s proximity tick
const COMPANION_INVITE_TTL_MS = 10 * 60 * 1000; // must match CitizenBonds INVITE_TTL_MS
const IGNORED_GRACE_MS = 2 * 60 * 1000; // extra window before an expired invite counts as ignored

// === Activities ===
const ACTIVITIES = [
  {
    id: "fishing",
    noun: "fishing trip",
    invites: [
      "Fancy a fishing trip? The river's biting today.",
      "I'm heading down to the river with my rod. Come with me?",
      "Fishing trip — you in? I know a quiet spot.",
    ],
  },
  {
    id: "dungeon",
    noun: "dungeon run",
    invites: [
      "I'm braving the dungeon soon. Want to watch my back?",
      "Dungeon run — I could use someone steady beside me. You in?",
      "Heading into the dark below. Come with me?",
    ],
  },
  {
    id: "walk",
    noun: "walk",
    invites: [
      "Fancy a walk? The air's nice and I could use the company.",
      "I'm taking a stroll around town. Walk with me?",
      "Going for a walk — join me?",
    ],
  },
  {
    id: "tavern",
    noun: "tavern drink",
    invites: [
      "I'm heading to the tavern for a drink. First round's on me?",
      "Tavern drink? I hear the ale's good today.",
      "Come share a drink with me at the tavern?",
    ],
  },
];

// Invitation flavor based on the citizen's history with this player.
const FLAVOR_WARM = [
  "Always up for an adventure, eh? {invite}",
  "My favorite companion! {invite}",
];
const FLAVOR_WISTFUL = [
  "I know you usually say no, but... {invite}",
  "You never join me, but I'll ask anyway — {invite}",
];
const FLAVOR_FIRST = ["{invite}"];

// === Cooldown + pending state ===
const lastInviteByCitizen = new Map(); // username -> timestamp
const pendingCompanion = new Map(); // "citizen:player" -> { activityId, sentAt }

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastInviteByCitizen) {
    if (at < cutoff) lastInviteByCitizen.delete(k);
  }
  for (const [k, v] of pendingCompanion) {
    if (v.sentAt < cutoff) pendingCompanion.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True only for real human players (not bots, not logged-out). */
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

/** Cheap Chebyshev distance check (same plane). */
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

/**
 * Decide whether this citizen should send an invite now.
 * Pure: (rng, lastInviteMs, nowMs) => boolean. Test this.
 */
function shouldInvite(rng, lastInviteMs, nowMs) {
  if (nowMs - (lastInviteMs || 0) < COMPANION_CITIZEN_COOLDOWN_MS) return false;
  return rng() < COMPANION_CHANCE;
}

/** Key for the pending-companion map. */
function pendingKey(citizenName, playerName) {
  return `${normalizeName(citizenName)}:${normalizeName(playerName)}`;
}

/**
 * Count accepted vs declined/ignored companion moments in the memory entry.
 * Pure over a moments array. Test this.
 */
function companionHistory(moments) {
  let accepted = 0;
  let declined = 0;
  for (const m of moments ?? []) {
    const t = String(m?.text ?? "");
    if (!/fishing trip|dungeon run|walk|tavern drink/i.test(t)) continue;
    if (/joined me for/i.test(t)) accepted++;
    else if (/turned down|ignored my/i.test(t)) declined++;
  }
  return { accepted, declined };
}

/**
 * Pick the invitation flavor based on history.
 * Pure: (history) => "warm" | "wistful" | "first". Test this.
 */
function flavorFor(history) {
  const total = history.accepted + history.declined;
  if (total === 0) return "first";
  if (history.accepted >= 2 && history.accepted > history.declined) return "warm";
  if (history.declined >= 2 && history.declined > history.accepted) return "wistful";
  return "first";
}

/**
 * Build the full invitation line.
 * Pure: (rng, activity, flavor) => string. Test this.
 */
function invitationLine(rng, activity, flavor) {
  const base = pickOne(rng, activity.invites);
  const pool =
    flavor === "warm" ? FLAVOR_WARM : flavor === "wistful" ? FLAVOR_WISTFUL : FLAVOR_FIRST;
  return pickOne(rng, pool).replace("{invite}", base);
}

// ============================================================================
// Memory helpers — thin wrappers around CitizenMemory, never throw.
// ============================================================================

function memMoment(citizenName, playerName, kind, text) {
  try {
    getMemory().recordMoment(citizenName, playerName, kind, text);
  } catch {
    // Non-fatal.
  }
}

function memTone(citizenName, playerName, delta) {
  try {
    getMemory().recordTone(citizenName, playerName, delta);
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

function memoryEntry(citizenName, playerName) {
  try {
    return getMemory().getEntry(citizenName, playerName);
  } catch {
    return null;
  }
}

// ============================================================================
// Invite lifecycle
// ============================================================================

/**
 * Find a pending companion invite from this citizen to this player.
 * Returns the invite object or null.
 */
function pendingInviteFor(citizenName, playerName) {
  try {
    const invites = getInvites(playerName) ?? [];
    return (
      invites.find(
        (i) =>
          i.kind === INVITE_COMPANION &&
          normalizeName(i.from) === normalizeName(citizenName)
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Player said "yes" to a companion invite. Records acceptance, sets follow.
 * Called from the chat keyword path. Returns the invite or null.
 */
function acceptCompanionInvite(playerName, citizenName) {
  const invite = pendingInviteFor(citizenName, playerName);
  if (!invite) return null;
  const activity = ACTIVITIES.find((a) => a.id === invite.data?.activityId);
  const noun = activity?.noun ?? "outing";
  try {
    resolveInvite(playerName, invite.id, true);
  } catch {
    // Non-fatal — still record the memory.
  }
  memMoment(citizenName, playerName, MOMENT_HELPED, `joined me for a ${noun}`);
  memTone(citizenName, playerName, 1);
  try {
    setFollow(citizenName, playerName, "companion");
  } catch {
    // Non-fatal.
  }
  journalEvent(citizenName, `${playerName} joined me for a ${noun}.`, "social");
  pendingCompanion.delete(pendingKey(citizenName, playerName));
  return invite;
}

/**
 * Player said "no" to a companion invite. Records the decline (mild tone dip,
 * not a grudge — saying no to a walk isn't a betrayal).
 * Called from the chat keyword path. Returns the invite or null.
 */
function declineCompanionInvite(playerName, citizenName) {
  const invite = pendingInviteFor(citizenName, playerName);
  if (!invite) return null;
  const activity = ACTIVITIES.find((a) => a.id === invite.data?.activityId);
  const noun = activity?.noun ?? "outing";
  try {
    resolveInvite(playerName, invite.id, false);
  } catch {
    // Non-fatal — still record the memory.
  }
  memMoment(citizenName, playerName, MOMENT_MET, `turned down my ${noun} invitation`);
  memTone(citizenName, playerName, -1);
  journalEvent(citizenName, `${playerName} turned down my ${noun} invitation.`, "social");
  pendingCompanion.delete(pendingKey(citizenName, playerName));
  return invite;
}

/**
 * Sweep pending companions for invites that expired without a response.
 * Records them as ignored (milder than a decline — the player might just
 * have been busy). Called from the tick.
 */
function expireCompanionInvites(nowMs) {
  try {
    for (const [key, pending] of pendingCompanion) {
      if (nowMs - pending.sentAt < COMPANION_INVITE_TTL_MS + IGNORED_GRACE_MS) continue;
      const [citizenName, playerName] = key.split(":");
      // If the invite is somehow still live, leave it alone.
      if (pendingInviteFor(citizenName, playerName)) continue;
      memMoment(
        citizenName,
        playerName,
        MOMENT_MET,
        `ignored my ${pending.activityNoun} invitation`
      );
      memTone(citizenName, playerName, -0.5);
      pendingCompanion.delete(key);
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Send a companion invite from this citizen to this player.
 * Returns the invite id or null.
 */
function sendCompanionInvite(citizen, record, player, nowMs, rng) {
  const playerName = player.getUsername();
  const citizenName = record.username;
  const activity = pickOne(rng, ACTIVITIES);

  // Flavor the invitation by history with this player.
  const entry = memoryEntry(citizenName, playerName);
  const history = companionHistory(entry?.moments);
  const flavor = flavorFor(history);
  const line = invitationLine(rng, activity, flavor);

  let id = null;
  try {
    id = sendInvite(citizenName, playerName, INVITE_COMPANION, {
      activityId: activity.id,
    });
  } catch {
    return null;
  }
  if (!id) return null;

  // Visible: the citizen speaks the invitation.
  try {
    citizen.forceChat(line);
  } catch {
    // Non-fatal — the invite is still pending.
  }
  try {
    player.message(
      `${record.displayName ?? citizenName} invites you on a ${activity.noun}. Say "yes" to join, "no" to decline.`
    );
  } catch {
    // Non-fatal.
  }

  pendingCompanion.set(pendingKey(citizenName, playerName), {
    activityId: activity.id,
    activityNoun: activity.noun,
    sentAt: nowMs,
  });
  lastInviteByCitizen.set(citizenName, nowMs);
  journalEvent(citizenName, `Invited ${playerName} on a ${activity.noun}.`, "social");
  return id;
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function realPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → citizen exists → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickCompanions(director, nowMs) {
  pruneState(nowMs);
  expireCompanionInvites(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      // 1. Cooldown gate — O(1), skips almost everyone
      const last = lastInviteByCitizen.get(record.username) || 0;
      if (nowMs - last < COMPANION_CITIZEN_COOLDOWN_MS) continue;

      // 2. Citizen must be materialized (near a player already)
      const citizen = (director.isOnline(record) ? director.getBot(record) : null);
      if (!citizen) continue;

      // 3. A real player must be within earshot
      const player = realPlayerNear(director, citizen, COMPANION_RADIUS);
      if (!player) continue;

      // 4. Don't stack invites on a player who already has one from anyone
      const key = pendingKey(record.username, player.getUsername());
      if (pendingCompanion.has(key)) continue;

      // 5. Chance gate + send (scripted, zero LLM)
      if (Math.random() >= COMPANION_CHANCE) continue;
      sendCompanionInvite(citizen, record, player, nowMs, Math.random);
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-companions] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickCompanions,
  acceptCompanionInvite,
  declineCompanionInvite,
  expireCompanionInvites,
  sendCompanionInvite,
  pendingInviteFor,
  INVITE_COMPANION,
  // Export pure helpers for tests:
  shouldInvite,
  companionHistory,
  flavorFor,
  invitationLine,
  pickOne,
  isRealPlayer,
  withinTiles,
  pendingKey,
  ACTIVITIES,
  COMPANION_CITIZEN_COOLDOWN_MS,
  COMPANION_CHANCE,
};
