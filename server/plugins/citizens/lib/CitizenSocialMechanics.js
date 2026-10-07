"use strict";

/**
 * CitizenSocialMechanics — citizens as full social agents.
 *
 * Runs on the director's tick (background tier, zero LLM). Evaluates
 * relationships from CitizenMemory/CitizenBonds and acts:
 *
 *   FRIENDS: Citizens befriend players who've earned it (favorites, high
 *     tone, many meetings). Sends a friend request invite; the player gets
 *     a game message and can accept via chat ("yes") or ::friend accept.
 *     Citizens also unfriend players who betray them (grudge 2+).
 *
 *   ENEMIES: Grudge 3 = enemy. Added to bonds. Consequences:
 *     - Refuse to chat (cold shoulder — checked in CitizenChat)
 *     - Refuse to trade (checked in shop/trade hooks)
 *     - Warn the player once ("Stay away from me.")
 *     Enemies are also removed from friends.
 *
 *   CLAN INVITES: Citizens with their own friends-chat channel invite
 *     players they're close to. Player joins via the normal clan chat UI.
 *
 *   BOSS TRIPS: Citizens invite trusted friends on expeditions (boss trips,
 *     dungeon runs). Accept → citizen follows the player (or vice versa).
 *
 *   PARTY: Lightweight adventuring party. Leader + members. Members follow
 *     the leader; party chat via the leader's friends-chat channel.
 *
 * Player → citizen actions go through chat keywords (handled in CitizenChat)
 * or the ::friend/::party commands (fallback for reliability).
 */

const {
  bonds,
  isFriend,
  addFriend,
  removeFriend,
  isEnemy,
  addEnemy,
  removeEnemy,
  sendInvite,
  getInvites,
  resolveInvite,
  getParty,
  setParty,
  clearParty,
  getFollow,
  setFollow,
  clearFollow,
  INVITE_FRIEND,
  INVITE_CLAN,
  INVITE_BOSS,
  INVITE_PARTY,
  normalizeName,
} = require("./CitizenBonds");
const { getMemory } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function memEntry(citizenName, playerName) {
  try {
    return getMemory().getEntry(citizenName, playerName) ?? null;
  } catch {
    return null;
  }
}

function allKnownPlayers(citizenName) {
  try {
    const rec = getMemory()._citizen(citizenName);
    return rec && rec.players instanceof Map ? [...rec.players.keys()] : [];
  } catch {
    return [];
  }
}

// How often the mechanics tick evaluates each citizen (probability per tick).
const FRIEND_REQUEST_CHANCE = 0.05; // 5% per tick for eligible citizens
const CLAN_INVITE_CHANCE = 0.03;
const BOSS_INVITE_CHANCE = 0.02;
const UNFRIEND_CHECK_CHANCE = 0.1;

// A citizen considers befriending a player when:
function isBefriendable(citizenName, playerName) {
  const entry = memEntry(citizenName, playerName);
  if (!entry || !entry.met) return false;
  if (isFriend(citizenName, playerName)) return false;
  if (isEnemy(citizenName, playerName)) return false;
  if ((entry.grudge ?? 0) > 0) return false;
  // Favorites (10+ meetings or 5000+ spent) or warm tone with 5+ meetings.
  const meetings = entry.meetings ?? 0;
  const tone = entry.tone ?? 0;
  return meetings >= 10 || (meetings >= 5 && tone >= 3);
}

// A citizen unfriends when betrayed.
function shouldUnfriend(citizenName, playerName) {
  if (!isFriend(citizenName, playerName)) return false;
  const entry = memEntry(citizenName, playerName);
  return (entry?.grudge ?? 0) >= 2;
}

// A citizen escalates to enemy at grudge 3.
function shouldBeEnemy(citizenName, playerName) {
  if (isEnemy(citizenName, playerName)) return false;
  const entry = memEntry(citizenName, playerName);
  return (entry?.grudge ?? 0) >= 3;
}

let pluginApi = null;

function init(api) {
  pluginApi = api;
}

function world() {
  try {
    return pluginApi?.core?.World ?? null;
  } catch {
    return null;
  }
}

function findPlayer(username) {
  try {
    return world()?.getPlayerByName?.(username) ?? null;
  } catch {
    return null;
  }
}

function notifyPlayer(player, message) {
  try {
    player?.sendMessage?.(message);
  } catch {
    // Non-fatal.
  }
}

/**
 * The per-tick evaluation. Called by the director for each roster citizen.
 * `getBot` resolves the citizen's live bot entity (null if offline).
 * `nearbyPlayers` lists real (non-bot) players near the citizen.
 */
function tickCitizen(record, getBot, nearbyPlayers) {
  const name = record.username;
  const rng = agentRng(`social:${name}:${Date.now() >> 16}`);
  const bot = getBot ? getBot(record) : null;

  // --- enemy escalation (from grudges) ---
  for (const playerKey of allKnownPlayers(name)) {
    if (shouldBeEnemy(name, playerKey)) {
      addEnemy(name, playerKey);
      removeFriend(name, playerKey);
      journalEvent(name, `Declared ${playerKey} an enemy. They went too far.`, "enemy");
      // Warn the player if they're online.
      const p = findPlayer(playerKey);
      if (p) notifyPlayer(p, `${record.displayName ?? name}: Stay away from me. We're done.`);
    } else if (shouldUnfriend(name, playerKey) && chance(rng, UNFRIEND_CHECK_CHANCE)) {
      removeFriend(name, playerKey);
      journalEvent(name, `Ended the friendship with ${playerKey}. Trust broken.`, "social");
    }
  }

  // --- outgoing friend requests (only when the player is nearby to respond) ---
  if (bot && Array.isArray(nearbyPlayers)) {
    // Clan channel creation: leader-material citizens start their own channel.
    if (!record.hasClanChannel && chance(rng, CLAN_CHANNEL_CHANCE)) {
      ensureClanChannel(record, getBot);
    }
    for (const player of nearbyPlayers) {
      const playerName = player?.getUsername?.();
      if (!playerName) continue;
      if (isBefriendable(name, playerName) && chance(rng, FRIEND_REQUEST_CHANCE)) {
        const id = sendInvite(name, playerName, INVITE_FRIEND);
        if (id) {
          journalEvent(name, `Sent a friend request to ${playerName}.`, "social");
          notifyPlayer(
            player,
            `${record.displayName ?? name} wants to be friends! ` +
              `Reply "yes" in chat to accept, or type ::friend accept ${name}.`
          );
        }
      }
      // --- clan invites (citizen has their own channel, player is a friend) ---
      if (
        isFriend(name, playerName) &&
        record.hasClanChannel &&
        chance(rng, CLAN_INVITE_CHANCE)
      ) {
        const id = sendInvite(name, playerName, INVITE_CLAN, { channel: name });
        if (id) {
          notifyPlayer(
            player,
            `${record.displayName ?? name} invited you to their clan chat '${name}'. ` +
              `Type ::friend accept ${name} clan, or join via the clan chat setup.`
          );
        }
      }
      // --- boss trip invites (close friends only) ---
      if (isFriend(name, playerName) && chance(rng, BOSS_INVITE_CHANCE)) {
        const b = bonds(name);
        if ((b.friends.length ?? 0) > 0) {
          // Only citizens who are brave/outgoing invite on boss trips.
          const traits = record.personality?.traits ?? [];
          if (traits.includes("brave") || traits.includes("outgoing") || traits.includes("ambitious")) {
            const id = sendInvite(name, playerName, INVITE_BOSS, { activity: "boss trip" });
            if (id) {
              journalEvent(name, `Invited ${playerName} on a boss trip.`, "social");
              notifyPlayer(
                player,
                `${record.displayName ?? name} wants you to join them on a boss trip! ` +
                  `Reply "yes" in chat to accept, or type ::friend accept ${name} boss.`
              );
            }
          }
        }
      }
    }
  }
}

// --- citizen-owned clan channels -------------------------------------------
// Citizens with leadership traits and enough friends create their own
// friends-chat channel. Sets record.hasClanChannel so tickCitizen can invite
// players. Bot-safe: UI sync calls are wrapped; the channel itself is data.

const CLAN_CHANNEL_CHANCE = 0.02; // 2% per tick for eligible citizens

function isClanLeaderMaterial(record) {
  const traits = record.personality?.traits ?? [];
  const hasTrait = traits.includes("outgoing") || traits.includes("ambitious") ||
    traits.includes("charismatic") || traits.includes("leader");
  const isLeaderRole = record.role === "courtier" || record.merchantKind === "prime";
  if (!hasTrait && !isLeaderRole) return false;
  const friends = bonds(record.username).friends;
  return (friends?.length ?? 0) >= 5;
}

function ensureClanChannel(record, getBot) {
  if (record.hasClanChannel) return true;
  if (!isClanLeaderMaterial(record)) return false;
  const bot = getBot ? getBot(record) : null;
  if (!bot) return false;
  try {
    const FriendsChatManager = require("../../interface/FriendsChatManager");
    // Channel name: 1-12 valid chars. Use a shortened display name.
    const rawName = String(record.displayName ?? record.username ?? "Clan").replace(/[^A-Za-z0-9 ]/g, "").trim();
    const chanName = (rawName.split(" ")[0] ?? "Clan").slice(0, 12) || "Clan";
    // Bot-safe channel setup: set relations name, create channel entry,
    // join own channel. Skip gameMessage/syncSetupText (player UI).
    try {
      bot.getRelations?.().setFriendsChatChannelName?.(chanName);
    } catch { /* non-fatal */ }
    const ownerKey = String(bot.getUsername?.() ?? record.username).toLowerCase();
    try {
      const profile = FriendsChatManager.profileFromPlayer?.(bot, { key: ownerKey }) ??
        { channelName: chanName };
      profile.channelName = chanName;
      const existing = FriendsChatManager.channels?.get?.(ownerKey);
      if (existing) {
        existing.profile = profile;
      } else {
        FriendsChatManager.channels?.set?.(ownerKey, {
          ownerKey, profile, members: new Map(),
        });
      }
    } catch { /* non-fatal */ }
    try {
      FriendsChatManager.join?.(bot, bot.getUsername?.() ?? record.username, false);
    } catch { /* non-fatal */ }
    record.hasClanChannel = true;
    journalEvent(record.username, `Started a clan chat channel '${chanName}'.`, "social");
    return true;
  } catch {
    return false;
  }
}

// --- follow behavior ---------------------------------------------------------
// Applied every tick for online citizens. Re-applies setFollowing so the
// brain's activity changes don't permanently break follow. Data tier drives,
// engine executes.

function tickFollow(record, getBot) {
  const name = record.username;
  const bot = getBot ? getBot(record) : null;
  if (!bot) return;

  // Priority 1: explicit follow (boss trip, "follow me").
  const follow = getFollow(name);
  // Priority 2: party follow (non-leader members follow the leader).
  const party = getParty(name);
  let targetName = null;
  let reason = null;
  if (follow?.target) {
    targetName = follow.target;
    reason = follow.reason;
  } else if (party && normalizeName(party.leader) !== normalizeName(name)) {
    targetName = party.leader;
    reason = "party";
  }
  if (!targetName) {
    // No follow target — make sure we're not stuck following.
    try {
      const current = bot.getFollowing?.();
      if (current) bot.setFollowing?.(null);
    } catch { /* non-fatal */ }
    return;
  }
  // Resolve the target entity (player or citizen bot).
  let target = null;
  try {
    target = findPlayer(targetName);
    if (!target && getBot) {
      // Maybe the target is another citizen bot.
      const director = require("../director/CitizenDirector").getDirector?.();
      const targetRecord = director?.roster?.get?.(targetName);
      if (targetRecord) target = getBot(targetRecord);
    }
  } catch { /* non-fatal */ }
  if (!target) {
    // Target gone (logged out) — clear explicit follow, keep party.
    if (follow?.target) clearFollow(name);
    try { bot.setFollowing?.(null); } catch { /* non-fatal */ }
    return;
  }
  // Apply follow if not already following this target.
  try {
    const current = bot.getFollowing?.();
    const currentName = current?.getUsername?.();
    if (normalizeName(currentName) !== normalizeName(targetName)) {
      bot.setFollowing?.(target);
      if (reason && reason !== "party") {
        journalEvent(name, `Following ${targetName} (${reason}).`, "social");
      }
    }
  } catch { /* non-fatal */ }
}

/** Player says "follow me" — citizen starts following the player. */
function requestFollow(citizenName, playerName) {
  if (isEnemy(citizenName, playerName)) return false;
  // Only friends or party members get followed.
  const party = getParty(citizenName);
  const inParty = party && (party.members ?? []).map(normalizeName).includes(normalizeName(playerName));
  if (!isFriend(citizenName, playerName) && !inParty) return false;
  setFollow(citizenName, playerName, "follow_me");
  journalEvent(citizenName, `Started following ${playerName}.`, "social");
  return true;
}

/** Player says "stop following" — citizen stops. */
function requestStopFollow(citizenName, playerName) {
  const follow = getFollow(citizenName);
  if (follow && normalizeName(follow.target) === normalizeName(playerName)) {
    clearFollow(citizenName);
    journalEvent(citizenName, `Stopped following ${playerName}.`, "social");
    return true;
  }
  return false;
}

// --- player-initiated actions (via chat keywords or commands) ----------------

/** Player accepts a pending invite from a citizen. */
function acceptInvite(playerName, citizenName, kind) {
  const invites = getInvites(playerName);
  const invite = invites.find(
    (i) => normalizeName(i.from) === normalizeName(citizenName) && (!kind || i.kind === kind)
  );
  if (!invite) return null;
  const result = resolveInvite(playerName, invite.id, true);
  if (!result) return null;
  // Apply invite effects.
  if (invite.kind === INVITE_BOSS) {
    // Boss trip accepted: citizen travels with the player.
    setFollow(citizenName, playerName, "boss_trip");
    journalEvent(citizenName, `Joining ${playerName} on a boss trip.`, "social");
  } else if (invite.kind === INVITE_PARTY) {
    // Party invite accepted: join the citizen's party (or create one).
    const party = getParty(citizenName);
    if (party) {
      joinParty(playerName, party);
    } else {
      createParty(citizenName, [playerName]);
    }
    setFollow(citizenName, playerName, "party");
    journalEvent(citizenName, `Joined a party with ${playerName}.`, "social");
  } else if (invite.kind === INVITE_CLAN) {
    journalEvent(citizenName, `${playerName} joined my clan chat.`, "social");
  } else {
    journalEvent(citizenName, `Became friends with ${playerName}.`, "social");
  }
  return result.invite;
}

/** Player sends a friend request to a citizen. */
function requestFriend(playerName, citizenName) {
  if (isFriend(citizenName, playerName)) return { already: true };
  if (isEnemy(citizenName, playerName)) return { enemy: true };
  const id = sendInvite(playerName, citizenName, INVITE_FRIEND);
  return { sent: !!id, id };
}

/** Citizen accepts a player's friend request (called when citizen is "asked"). */
function citizenAcceptFriend(citizenName, playerName) {
  const result = resolveInvite(citizenName, getInvites(citizenName).find(
    (i) => normalizeName(i.from) === normalizeName(playerName) && i.kind === INVITE_FRIEND
  )?.id, true);
  if (result) {
    journalEvent(citizenName, `Accepted ${playerName}'s friend request.`, "social");
    return true;
  }
  // No pending request — citizen decides based on relationship.
  if (isBefriendable(citizenName, playerName)) {
    addFriend(citizenName, playerName);
    addFriend(playerName, citizenName);
    journalEvent(citizenName, `Became friends with ${playerName}.`, "social");
    return true;
  }
  return false;
}

// --- party ------------------------------------------------------------------

let partySeq = 0;

function createParty(leaderName, memberNames) {
  const id = `party_${Date.now()}_${++partySeq}`;
  const members = [normalizeName(leaderName)];
  for (const m of memberNames ?? []) {
    const n = normalizeName(m);
    if (n && !members.includes(n)) members.push(n);
  }
  const party = { id, leader: normalizeName(leaderName), members, createdAt: Date.now() };
  for (const m of members) setParty(m, party);
  return party;
}

function joinParty(citizenName, party) {
  if (!party || !Array.isArray(party.members)) return false;
  const n = normalizeName(citizenName);
  if (!party.members.includes(n)) party.members.push(n);
  setParty(citizenName, party);
  // Sync to all existing members.
  for (const m of party.members) {
    if (m !== n) setParty(m, party);
  }
  return true;
}

function leaveParty(name) {
  const party = getParty(name);
  if (!party) return false;
  const n = normalizeName(name);
  party.members = (party.members ?? []).filter((m) => m !== n);
  clearParty(name);
  // Re-share the SAME object reference with every surviving member — the
  // invariant createParty/joinParty establish. Spread copies here used to
  // freeze stale state (members, phase, battleTicks) on the leader's copy
  // and strand phantom members after the second offline drop.
  for (const m of party.members) {
    const mp = getParty(m);
    if (mp && mp.id === party.id) setParty(m, party);
  }
  return true;
}

function disbandParty(leaderName) {
  const party = getParty(leaderName);
  if (!party || normalizeName(party.leader) !== normalizeName(leaderName)) return false;
  for (const m of party.members ?? []) clearParty(m);
  return true;
}

// --- citizen agency: acting on goals ----------------------------------------
// Runs in the background tick (data tier, zero LLM). Citizens make decisions
// from their goals and relationships; the journal records them so the
// foreground LLM can speak truthfully about what they did.

function tickAgency(record, rng) {
  const name = record.username;
  const goal = record.goal;
  if (!goal || goal.completedAt) return;

  // Merchants pursuing wealth: seek busy spots, hawk wares aggressively.
  if (goal.type === "save_gold") {
    if (chance(rng, 0.1)) {
      journalEvent(name, "Moved the stall to a busier corner. Foot traffic is money.", "work");
      record.agencyNote = "seeking_customers";
    }
  }
  // Guards pursuing rank: volunteer for extra duty, be visible.
  if (goal.type === "rank_up") {
    if (chance(rng, 0.1)) {
      journalEvent(name, "Volunteered for an extra patrol. The captain notices effort.", "work");
      record.agencyNote = "seeking_duty";
    }
  }
  // Commoners mastering a trade: practice, seek mentors.
  if (goal.type === "master_trade") {
    if (chance(rng, 0.08)) {
      journalEvent(name, "Practiced the craft late. Hands are raw but better.", "work");
      record.agencyNote = "practicing";
    }
  }
  // Citizens with friends: seek them out when nearby players include friends.
  // (The nearby-players version runs in tickCitizen; this is the data echo.)
  if (chance(rng, 0.05)) {
    const friends = bonds(name).friends;
    if (friends.length > 0) {
      const f = friends[Math.floor(rng() * friends.length)];
      journalEvent(name, `Thought about ${f}. Hope they're well.`, "social");
    }
  }
  // Citizens with enemies: avoid or steel themselves.
  if (chance(rng, 0.05)) {
    const enemies = bonds(name).enemies;
    if (enemies.length > 0) {
      const e = enemies[Math.floor(rng() * enemies.length)];
      journalEvent(
        name,
        `Saw ${e} across the street. Turned away. Not today.`,
        "enemy"
      );
    }
  }
}

module.exports = {
  init,
  tickCitizen,
  tickAgency,
  tickFollow,
  ensureClanChannel,
  isBefriendable,
  shouldUnfriend,
  shouldBeEnemy,
  acceptInvite,
  requestFriend,
  citizenAcceptFriend,
  requestFollow,
  requestStopFollow,
  createParty,
  joinParty,
  leaveParty,
  disbandParty,
  getParty,
};
