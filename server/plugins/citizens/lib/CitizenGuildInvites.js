"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

/**
 * CitizenGuildInvites — citizens invite real players to their (engine) guilds.
 *
 * WHAT IT DOES (data tier, free):
 *   A citizen who is an officer or founder of a player-founded guild, and who
 *   is friends with a nearby real player (CitizenBonds friendship), sometimes
 *   invites that player to join their guild — through the EXISTING guild
 *   system (GuildRegistry.inviteMember). No new guild machinery.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   The citizen says the invitation out loud (sayPublic, voiced) and the
 *   player gets a nudge: say "accept guild" to join, "decline guild" to pass
 *   (the existing diegetic keywords in Guilds.plugin.js; the web overlay's
 *   guilds endpoint also lists the pending invite for the guild panel).
 *
 * MEMORY (the point of this module):
 *   Every outcome is recorded in CitizenMemory:
 *     - accepted: MOMENT_HELPED "joined my guild '<name>'" (+2 tone)
 *     - declined: MOMENT_MET "turned down my guild invitation" (-1 tone)
 *     - ignored:  MOMENT_MET "ignored my guild invitation" (-0.5 tone)
 *   A declined invite also writes a 7-DAY no-re-ask block (persisted to
 *   data/saves/citizen-guild-invites.json) — the citizen will not nag a
 *   player who said no. Invitation lines are flavored by history: players
 *   who usually accept sound warm, repeat decliners sound wistful.
 *
 * Zero LLM: invitation lines are scripted pools; memory is data.
 * Cooldown: one guild invite per citizen per 2 hours (not spammy).
 *
 * Wired into the director proximity tick next to tickCompanions.
 * Outcome hooks live in Guilds.plugin.js / GuildsApi.js (peek + resolve).
 * Plain-node testable: CitizenGuildInvites.test.js.
 */

const Registry = require("../../guilds/GuildRegistry");
const { isFriend, normalizeName } = require("./CitizenBonds");
const { getMemory, MOMENT_HELPED, MOMENT_MET } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");

// === Tuning: all magic numbers here ===
const GUILD_INVITE_RADIUS = 10; // tiles — close enough for an in-person invite
const GUILD_INVITE_CITIZEN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // one invite per citizen per 2h
const GUILD_INVITE_CHANCE = 0.1; // per eligible citizen per ~10s proximity tick
const GUILD_INVITE_DECLINE_REASK_MS = 7 * 24 * 60 * 60 * 1000; // no re-ask for 7 days after a decline
const IGNORED_GRACE_MS = 5 * 60 * 1000; // extra window past Registry.INVITE_TTL_MS before "ignored"

// === Invitation lines (scripted, zero LLM) ===
// Overhead chat truncates at 80 chars (ChatPacketListener) — keep every
// line short. The direct nudge always carries the exact accept/decline
// phrases, so the spoken line just needs the invitation and the guild name.
const INVITE_LINES = [
  "The {guild} could use you. Say the word!",
  "I'm with the {guild} — you'd fit right in. Join us?",
  "The {guild} has a seat for you. Join us?",
  "My guild, the {guild}, would be glad to have you.",
];

// Invitation flavor based on the citizen's history with this player.
const FLAVOR_WARM = [
  "Old friend — {invite}",
  "You always say yes. {invite}",
];
const FLAVOR_WISTFUL = [
  "You said no before, but — {invite}",
  "One more try, friend — {invite}",
];
const FLAVOR_FIRST = ["{invite}"];

const WELCOME_LINES = [
  "Welcome to the {guild}, {player}!",
  "Ha! The {guild} grows stronger. Welcome, {player}!",
];

// === Persistence: decline no-re-ask blocks ===
const fs = require("fs");
const path = require("path");
const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-guild-invites.json");

let declineSave = null; // { declines: { "citizen:player": ts } }
let declineDirty = false;

function declineData() {
  if (!declineSave) {
    try {
      if (fs.existsSync(SAVE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
        declineSave = { declines: raw?.declines ?? {} };
      } else {
        declineSave = { declines: {} };
      }
    } catch {
      declineSave = { declines: {} };
    }
  }
  return declineSave;
}

function flushDeclines(nowMs) {
  if (!declineDirty) return;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    const cutoff = nowMs - GUILD_INVITE_DECLINE_REASK_MS;
    const pruned = {};
    for (const [k, ts] of Object.entries(declineData().declines)) {
      if (ts > cutoff) pruned[k] = ts;
    }
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ declines: pruned }));
    declineDirty = false;
  } catch {
    // Never break the tick on a save failure.
  }
}

// === Cooldown + pending state (in-memory; declines persist above) ===
const lastInviteByCitizen = new Map(); // username -> timestamp
const pendingGuildInvite = new Map(); // normalizeName(player) -> { citizenUsername, guildId, sentAt }

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastInviteByCitizen) {
    if (at < cutoff) lastInviteByCitizen.delete(k);
  }
  for (const [k, v] of pendingGuildInvite) {
    if (v.sentAt < cutoff) pendingGuildInvite.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Decide whether this citizen should send an invite now.
 * Pure: (rng, lastInviteMs, nowMs) => boolean. Test this.
 */
function shouldInvite(rng, lastInviteMs, nowMs) {
  if (nowMs - (lastInviteMs || 0) < GUILD_INVITE_CITIZEN_COOLDOWN_MS) return false;
  return rng() < GUILD_INVITE_CHANCE;
}

/** Key for the pending + decline maps. */
function pendingKey(citizenName, playerName) {
  return `${normalizeName(citizenName)}:${normalizeName(playerName)}`;
}

/**
 * True if this citizen may ask this player again now — i.e. no recent
 * decline within the no-re-ask window. Pure over the declines map.
 */
function canReAsk(declines, citizenName, playerName, nowMs) {
  const ts = declines?.[pendingKey(citizenName, playerName)] ?? 0;
  return nowMs - ts >= GUILD_INVITE_DECLINE_REASK_MS;
}

/**
 * Count accepted vs declined/ignored guild-invite moments in the memory entry.
 * Pure over a moments array. Test this.
 */
function inviteHistory(moments) {
  let accepted = 0;
  let declined = 0;
  for (const m of moments ?? []) {
    const t = String(m?.text ?? "");
    if (!/guild invitation|joined my guild/i.test(t)) continue;
    if (/joined my guild/i.test(t)) accepted++;
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
  if (history.accepted >= 1 && history.accepted > history.declined) return "warm";
  if (history.declined >= 2 && history.declined > history.accepted) return "wistful";
  return "first";
}

/**
 * Build the full invitation line.
 * Pure: (rng, guildName, flavor) => string. Test this.
 */
function invitationLine(rng, guildName, flavor) {
  const base = pickOne(rng, INVITE_LINES).replace("{guild}", guildName);
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
 * Peek at the citizen-sent guild invite tracked for this player, if the
 * pending invite to guildId came from a citizen. Non-destructive — call
 * BEFORE the registry accept/decline, then resolveOutcome() after.
 * Returns { citizenUsername, guildId } or null.
 */
function peekPendingInvite(playerName, guildId) {
  try {
    const pending = pendingGuildInvite.get(normalizeName(playerName));
    if (!pending) return null;
    if (String(pending.guildId) !== String(guildId)) return null;
    return { citizenUsername: pending.citizenUsername, guildId: pending.guildId };
  } catch {
    return null;
  }
}

/**
 * Record the outcome of a citizen-sent guild invite after the player said
 * "accept guild" / "decline guild" (or used the web overlay).
 * Removes the tracked pending invite. Safe to call when none is tracked.
 */
function resolveOutcome(playerName, guildId, accepted, nowMs = Date.now()) {
  try {
    const pending = pendingGuildInvite.get(normalizeName(playerName));
    if (!pending || String(pending.guildId) !== String(guildId)) return null;
    pendingGuildInvite.delete(normalizeName(playerName));
    const citizenName = pending.citizenUsername;
    let guildName = "the guild";
    try {
      guildName = Registry.getGuild(guildId)?.name ?? guildName;
    } catch {
      // Non-fatal.
    }
    if (accepted) {
      memMoment(citizenName, playerName, MOMENT_HELPED, `joined my guild '${guildName}'`);
      memTone(citizenName, playerName, 2);
      journalEvent(citizenName, `${playerName} joined my guild '${guildName}'.`, "social");
    } else {
      memMoment(citizenName, playerName, MOMENT_MET, `turned down my guild invitation to '${guildName}'`);
      memTone(citizenName, playerName, -1);
      journalEvent(citizenName, `${playerName} turned down my guild invitation to '${guildName}'.`, "social");
      // 7-day no-re-ask block — the citizen won't nag a player who said no.
      declineData().declines[pendingKey(citizenName, playerName)] = nowMs;
      declineDirty = true;
      flushDeclines(nowMs);
    }
    return { citizenUsername: citizenName, guildId, guildName, accepted };
  } catch {
    return null;
  }
}

/**
 * Sweep tracked invites whose registry TTL expired without a response.
 * Records them as ignored (milder than a decline — the player might just
 * have been busy). Called from the tick.
 */
function expireGuildInvites(nowMs) {
  try {
    const ttl = Registry.INVITE_TTL_MS ?? 30 * 60 * 1000;
    for (const [playerKey, pending] of pendingGuildInvite) {
      if (nowMs - pending.sentAt < ttl + IGNORED_GRACE_MS) continue;
      const citizenName = pending.citizenUsername;
      // If the invite is somehow still live, leave it alone.
      let stillLive = false;
      try {
        stillLive = Registry.pendingInvitesFor(playerKey).some(
          (i) => String(i.guildId) === String(pending.guildId)
        );
      } catch {
        // Non-fatal — treat as expired below.
      }
      if (stillLive) continue;
      let guildName = "the guild";
      try {
        guildName = Registry.getGuild(pending.guildId)?.name ?? guildName;
      } catch {
        // Non-fatal.
      }
      memMoment(citizenName, playerKey, MOMENT_MET, `ignored my guild invitation to '${guildName}'`);
      memTone(citizenName, playerKey, -0.5);
      pendingGuildInvite.delete(playerKey);
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Send a guild invite from this citizen to this player.
 * The citizen must already be an officer or founder (enforced again by
 * Registry.inviteMember). Returns true on success.
 */
function sendGuildInvite(citizen, record, player, guild, nowMs, rng) {
  const playerName = player.getUsername();
  const citizenName = record.username;
  const citizenDisplay = record.displayName ?? citizenName;
  const guildName = guild.name;

  let res = null;
  try {
    res = Registry.inviteMember(guild.id, playerName, playerName, citizenName, citizenDisplay);
  } catch {
    return false;
  }
  if (res?.error) return false;

  // Flavor the invitation by history with this player.
  const entry = memoryEntry(citizenName, playerName);
  const history = inviteHistory(entry?.moments);
  const flavor = flavorFor(history);
  const line = invitationLine(rng, guildName, flavor);

  // Visible: the citizen speaks the invitation in person.
  try {
    const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] }));
  } catch {
    // Non-fatal — the invite is still pending.
  }
  try {
    player.sendMessage(
      `${citizenDisplay} invited you to the guild '${guildName}'. ` +
        `Say "accept guild" to join, "decline guild" to pass.`
    );
  } catch {
    // Non-fatal.
  }

  pendingGuildInvite.set(normalizeName(playerName), {
    citizenUsername: citizenName,
    guildId: guild.id,
    sentAt: nowMs,
  });
  lastInviteByCitizen.set(citizenName, nowMs);
  journalEvent(citizenName, `Invited ${playerName} to join my guild '${guildName}'.`, "social");
  return true;
}

/**
 * The inviting citizen welcomes a new member out loud (if online).
 * Called after a successful accept; best-effort only.
 */
function welcomeNewMember(director, info, playerName) {
  if (!info?.citizenUsername || !director) return;
  try {
    const record = director.roster?.get?.(normalizeName(info.citizenUsername));
    const citizen = record && director.isOnline(record) ? director.getBot(record) : null;
    if (!citizen) return;
    const line = pickOne(Math.random, WELCOME_LINES)
      .replace("{guild}", info.guildName ?? "the guild")
      .replace("{player}", playerName);
    const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] }));
  } catch {
    // Non-fatal.
  }
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

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function realPlayerNear(director, citizen, radius) {
  try {
    const roster = director.roster?.values?.() ?? [];
    for (const r of roster) {
      if (!director.isOnline(r)) continue;
      const p = director.getBot(r);
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
// Gate order: cooldown (cheapest) → citizen materialized → guild officer+
// → real player near → friendship → no pending invites → re-ask ok.
// ============================================================================

/**
 * Pure eligibility check for one citizen/player pair: returns the guild the
 * citizen may invite the player to, or null. Test this.
 *
 * @param {string} citizenName - normalized citizen username
 * @param {object} guild - Registry guild object the citizen belongs to
 * @param {string} playerName - the real player's username
 * @param {object} opts - { declines, nowMs }
 */
function eligibleGuild(citizenName, guild, playerName, opts = {}) {
  if (!guild) return null;
  if (!Registry.isOfficerOrFounder(guild, citizenName)) return null;
  if (Registry.memberGuild(playerName)) return null; // player already guilded
  try {
    if ((Registry.pendingInvitesFor(playerName) ?? []).length) return null; // don't stack invites
  } catch {
    return null;
  }
  if (!isFriend(citizenName, playerName)) return null; // bonded players only
  if (!canReAsk(opts.declines ?? declineData().declines, citizenName, playerName, opts.nowMs ?? Date.now())) {
    return null; // declined recently — don't nag
  }
  return guild;
}

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickGuildInvites(director, nowMs) {
  pruneState(nowMs);
  expireGuildInvites(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      // 1. Cooldown gate — O(1), skips almost everyone
      const last = lastInviteByCitizen.get(record.username) || 0;
      if (nowMs - last < GUILD_INVITE_CITIZEN_COOLDOWN_MS) continue;

      // 2. Citizen must be materialized (near a player already)
      const citizen = director.isOnline(record) ? director.getBot(record) : null;
      if (!citizen) continue;

      // 3. A real player must be within earshot
      const player = realPlayerNear(director, citizen, GUILD_INVITE_RADIUS);
      if (!player) continue;

      // 4. One tracked invite per player at a time
      if (pendingGuildInvite.has(normalizeName(player.getUsername()))) continue;

      // 5. Eligibility: officer/founder, friend, guildless, no pending, re-ask ok
      let guild = null;
      try {
        guild = Registry.memberGuild(record.username);
      } catch {
        guild = null;
      }
      const okGuild = eligibleGuild(record.username, guild, player.getUsername(), {
        declines: declineData().declines,
        nowMs,
      });
      if (!okGuild) continue;

      // 6. Chance gate + send (scripted, zero LLM)
      if (Math.random() >= GUILD_INVITE_CHANCE) continue;
      sendGuildInvite(citizen, record, player, okGuild, nowMs, Math.random);
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-guild-invites] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickGuildInvites,
  sendGuildInvite,
  peekPendingInvite,
  resolveOutcome,
  expireGuildInvites,
  welcomeNewMember,
  eligibleGuild,
  // Export pure helpers for tests:
  shouldInvite,
  canReAsk,
  inviteHistory,
  flavorFor,
  invitationLine,
  pickOne,
  isRealPlayer,
  withinTiles,
  pendingKey,
  INVITE_LINES,
  GUILD_INVITE_CITIZEN_COOLDOWN_MS,
  GUILD_INVITE_CHANCE,
  GUILD_INVITE_DECLINE_REASK_MS,
  SAVE_FILE,
};
