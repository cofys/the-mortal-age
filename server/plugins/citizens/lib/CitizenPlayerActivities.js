"use strict";

/**
 * CitizenPlayerActivities — let real players JOIN citizen activities.
 *
 * Citizens form fishing parties, skilling sessions and boss runs on their
 * own. This module is the bridge that turns nearby real players from
 * spectators into participants:
 *
 *  - OFFER: when an activity party/session/run forms and real players are
 *    nearby, the leader shouts the usual form line (data-tier) AND each
 *    nearby player gets an INVITE_ACTIVITY invite plus a game-message
 *    nudge ("Reply \"yes\" in chat to join").
 *  - JOIN: the player says "yes" (existing chat-keyword path) ->
 *    acceptInvite -> acceptActivityInvite validates the party is still the
 *    same one, adds the player via joinParty, and records the bonding.
 *  - PARTICIPATE: maintenance loops no longer eject online real players;
 *    boss-run descent/send-home moves them with the party; skilling and
 *    fishing loot is shared with them at the end.
 *  - BOND: joining records a meeting + warm tone; completing an activity
 *    together gives every citizen member a bigger tone bump toward each
 *    player member, so regular fishing buddies drift toward friendship
 *    through the existing isBefriendable mechanics.
 *
 * Data tier, zero LLM. Everything here is state + journal + inventory.
 */

const {
  isEnemy,
  sendInvite,
  getParty,
  normalizeName,
  INVITE_ACTIVITY,
} = require("./CitizenBonds");
const { getMemory } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");
const { agentRng } = require("./humanizer");

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function playerNameOf(p) {
  try {
    return p?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/** The live engine player entity for a name, or null. */
function isOnlinePlayer(director, name) {
  try {
    const p = director?.api?.core?.World?.getPlayerByName?.(name);
    return p ?? null;
  } catch {
    return null;
  }
}

/** Online real-player member names of a party (citizens come from roster). */
function playerMembers(director, party) {
  const out = [];
  for (const m of party?.members ?? []) {
    if (director?.roster?.get?.(normalizeName(m))) continue; // citizen
    if (isOnlinePlayer(director, m)) out.push(m);
  }
  return out;
}

function notifyPlayerEntity(player, message) {
  try {
    player?.sendMessage?.(message);
  } catch {
    // Non-fatal.
  }
}

function givePlayerItem(director, playerName, itemId, n) {
  try {
    const player = isOnlinePlayer(director, playerName);
    if (!player || !itemId || !(n > 0)) return false;
    const Item = director?.api?.core?.Item;
    if (!Item) return false;
    player.getInventory()?.add?.(new Item(itemId, n));
    return true;
  } catch {
    return false;
  }
}

function movePlayerTo(director, playerName, x, y, z) {
  try {
    const player = isOnlinePlayer(director, playerName);
    if (!player) return false;
    const Location = director?.api?.core?.Location;
    if (!Location || !player.moveTo) return false;
    player.moveTo(new Location(x, y, z ?? 0));
    return true;
  } catch {
    return false;
  }
}

// --- offer --------------------------------------------------------------------

/**
 * Called when an activity party/session/run forms. If real players are near
 * the leader, shout the form line (existing behavior) and send each of them
 * an activity invite with a game-message nudge explaining how to join.
 *
 * opts: { activityId, label, formLines }
 * Returns the invited player names.
 */
function offerActivityToPlayers(director, record, party, opts) {
  const invited = [];
  try {
    const bot = director.getBot(record);
    if (!bot || !party) return invited;
    const rng = agentRng(`pact:${record.username}:${Date.now() >> 16}`);
    const players = realPlayersNear(bot)
      .filter((p) => {
        const pn = playerNameOf(p);
        return pn && !isEnemy(record.username, pn);
      })
      // Relationships matter: friends get invited first, strangers after.
      // A citizen leader thinks of their favorite fishing buddy before a
      // random passerby. Sort is stable — neutrals keep arrival order.
      .sort((pa, pb) => {
        try {
          const memory = getMemory();
          const rank = { favorite: 0, regular: 1, warm: 2, neutral: 3, cold: 4 };
          const sa = rank[memory.standing(record.username, playerNameOf(pa)) ?? "neutral"] ?? 3;
          const sb = rank[memory.standing(record.username, playerNameOf(pb)) ?? "neutral"] ?? 3;
          return sa - sb;
        } catch {
          return 0;
        }
      });
    if (players.length > 0) {
      const line = pickOne(rng, opts.formLines ?? ["We're heading out — anyone's welcome!"]);
      try {
        bot.forceChat?.(line);
      } catch {
        // Non-fatal.
      }
      const display = record.displayName ?? record.username;
      for (const p of players) {
        const pn = playerNameOf(p);
        if (!pn) continue;
        sendInvite(record.username, pn, INVITE_ACTIVITY, {
          activityId: opts.activityId,
          label: opts.label,
          partyId: party.id,
          leader: normalizeName(record.username),
        });
        notifyPlayerEntity(
          p,
          `${display} is forming a ${opts.label} and invited you along! ` +
            `Reply "yes" in chat to join the party.`
        );
        invited.push(pn);
      }
      journalEvent(
        record.username,
        `Invited ${invited.join(", ")} to join the ${opts.label}.`,
        "social"
      );
    }
  } catch {
    // Non-fatal.
  }
  return invited;
}

// --- join ---------------------------------------------------------------------

/**
 * Player accepted an INVITE_ACTIVITY from a citizen. Validate the party is
 * still the one from the invite, add the player, record the bonding.
 * Returns true when the player actually joined.
 */
function acceptActivityInvite(playerName, citizenName, invite) {
  try {
    const SocialMechanics = require("./CitizenSocialMechanics");
    const party = getParty(citizenName);
    const data = invite?.data ?? {};
    // The party must still exist, still be led by the inviter, still be the
    // same party, and still be an activity (not a repurposed social party).
    if (
      !party ||
      normalizeName(party.leader) !== normalizeName(citizenName) ||
      (data.partyId && party.id !== data.partyId) ||
      !party.activity
    ) {
      notifyPlayerEntity(
        onlinePlayerByName(playerName),
        "Too late — that group already headed out without you."
      );
      return false;
    }
    if (!SocialMechanics.joinParty(playerName, party)) return false;

    const label = data.label ?? "outing";
    const mem = getMemory();
    try {
      mem.recordMeeting(citizenName, playerName);
      mem.recordTone(citizenName, playerName, 1);
    } catch {
      // Non-fatal.
    }
    journalEvent(
      citizenName,
      `${playerName} joined my ${label} — good to have them along.`,
      "social"
    );
    // The public "we've got company" announcement goes out via
    // notifyCitizenSpoke's activity_invite line (called by the chat path
    // after acceptInvite) — no duplicate shout here.
    notifyPlayerEntity(
      onlinePlayerByName(playerName),
      `You're in! Stay close — the ${label} is heading out.`
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up a live engine player by name via the singleton director.
 * acceptInvite's signature doesn't carry the director, so this is the
 * fallback path for join/leave notifications.
 */
function onlinePlayerByName(playerName) {
  try {
    const { getDirector } = require("../director/CitizenDirector");
    const director = getDirector();
    return director?.api?.core?.World?.getPlayerByName?.(playerName) ?? null;
  } catch {
    return null;
  }
}

// --- shared rewards ------------------------------------------------------------

/** End-of-trip loot share for player members (fishing trips etc.). */
function grantActivityLootToPlayers(director, party, itemId, min, max) {
  const players = playerMembers(director, party);
  if (!players.length || !itemId) return;
  const rng = agentRng(`pact:loot:${party.id}`);
  for (const pn of players) {
    const n = min + Math.floor(rng() * (max - min + 1));
    if (givePlayerItem(director, pn, itemId, n)) {
      notifyPlayerEntity(
        isOnlinePlayer(director, pn),
        `You take your share of the catch: ${n} raw shrimps.`
      );
    }
  }
}

/** Boss-kill loot share for player members. items/bonus/note are optional: when
 *  omitted the Giant Mole loot is used (backward compatible). */
function grantBossLootToPlayers(director, party, rng, items, bonus, note) {
  const players = playerMembers(director, party);
  const spec = items ?? [[7416, 1], [7418, [1, 2]]]; // mole claw + skins (npc-drops.json)
  const noteOf =
    note ??
    ((picked) => {
      const skins = (picked.find((p) => p.id === 7418) ?? { qty: 0 }).qty;
      return `You loot a mole claw and ${skins} mole skins from the Giant Mole.`;
    });
  for (const pn of players) {
    const picked = [];
    for (const [id, qty] of spec) {
      const n = Array.isArray(qty) ? qty[0] + Math.floor(rng() * (qty[1] - qty[0] + 1)) : qty;
      if (n > 0) {
        picked.push({ id, qty: n });
        givePlayerItem(director, pn, id, n);
      }
    }
    let bonusName = null;
    if (bonus && rng() < bonus.chance) {
      const [bid, bname] = bonus.items[Math.floor(rng() * bonus.items.length)];
      givePlayerItem(director, pn, bid, 1);
      picked.push({ id: bid, qty: 1 });
      bonusName = bname;
    }
    notifyPlayerEntity(isOnlinePlayer(director, pn), noteOf(picked, bonusName));
  }
}

/** End-of-session crew share for player members (skilling sessions). */
function awardSkillingShare(director, session, def) {
  const party = getParty(session.leader);
  if (!party) return;
  const players = playerMembers(director, party);
  if (!players.length) return;
  const rng = agentRng(`pact:skillshare:${session.leader}:${Date.now() >> 16}`);
  for (const pn of players) {
    let itemId = def.item;
    if (session.skill === "mining") itemId = pickOne(rng, def.items);
    if (session.skill === "cooking") itemId = def.produces;
    const n = 4 + Math.floor(rng() * 5); // 4-8 crew share
    if (itemId && givePlayerItem(director, pn, itemId, n)) {
      const what =
        session.skill === "woodcutting"
          ? "logs"
          : session.skill === "fishing"
            ? "shrimps"
            : session.skill === "mining"
              ? "ore"
              : "cooked shrimps";
      notifyPlayerEntity(
        isOnlinePlayer(director, pn),
        `Your share of the crew's work: ${n} ${what}.`
      );
    }
  }
}

/** Move every online player member of a party to a tile (boss descent, send-home). */
function movePlayerMembersTo(director, party, x, y, z) {
  for (const pn of playerMembers(director, party)) {
    movePlayerTo(director, pn, x, y, z);
  }
}

// --- bonding -------------------------------------------------------------------

/**
 * After an activity completes, every citizen member warms toward every
 * player member. Regular activity buddies accumulate tone + meetings and
 * drift into friendship through the existing befriendable mechanics.
 */
function bondAfterActivity(director, party, label) {
  try {
    const players = playerMembers(director, party);
    if (!players.length) return;
    const mem = getMemory();
    for (const m of party?.members ?? []) {
      if (players.some((p) => normalizeName(p) === normalizeName(m))) continue;
      const rec = director?.roster?.get?.(normalizeName(m));
      if (!rec || !director.isOnline(rec)) continue;
      for (const pn of players) {
        try {
          mem.recordMeeting(m, pn);
          mem.recordTone(m, pn, 2);
        } catch {
          // Non-fatal.
        }
      }
    }
    journalEvent(
      normalizeName(party?.leader),
      `Finished the ${label} with ${players.join(", ")} — good company.`,
      "social"
    );
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  INVITE_ACTIVITY,
  offerActivityToPlayers,
  acceptActivityInvite,
  isOnlinePlayer,
  playerMembers,
  grantActivityLootToPlayers,
  grantBossLootToPlayers,
  awardSkillingShare,
  movePlayerMembersTo,
  bondAfterActivity,
};
