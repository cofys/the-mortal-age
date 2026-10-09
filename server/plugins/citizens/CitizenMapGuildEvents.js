"use strict";

/**
 * CitizenMapGuildEvents — player-facing cartographers' guild: the ::mapguild command.
 *
 * Mirrors the ::dig / ::stage / ::runway command pattern (PlayerRights.NONE
 * so every player can use it). Players can join the guild, pay dues, submit
 * their shop-listed maps for guild certification, view/post/claim survey
 * bounties, browse the certified archive, and arrange mentorship. Bots are
 * rejected: citizens act through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenMapGuilds");

const COINS_ID = 995;

const MAPGUILD_USAGE =
  "::mapguild [status|join|leave|dues|certify <mapId>|bounties|post <type> <reward>|claim <bountyId>|archive|apprentice <name>]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    return player?.isRealPlayer?.() ?? !player?.isBot;
  } catch {
    return true;
  }
}

function say(player, text) {
  try {
    player?.sendMessage?.(text);
  } catch {
    // messaging is best-effort
  }
}

function kingdomOf(player) {
  try {
    const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

function giveCoins(player, amount) {
  try {
    player?.getInventory?.()?.add?.(COINS_ID, amount);
    return true;
  } catch {
    return false;
  }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const has = inv.getAmount?.(COINS_ID) ?? inv.count?.(COINS_ID) ?? 0;
    if (has < amount) return false;
    if (typeof inv.remove === "function") inv.remove(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    else return false;
    return true;
  } catch {
    return false;
  }
}

function onMapGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const home = kingdomOf(player);
  const sub = String(args?.[0] ?? "status").toLowerCase();

  if (sub === "status") {
    const mem = Guilds.memberOf(username);
    if (!mem) {
      say(player, "You are not a guild member. ::mapguild join — cartographers only.");
      if (home) {
        const d = Guilds.describe(home);
        if (d.exists) say(player, `The ${home} guild hall stands by the map shop: ${d.memberCount} members, ${d.masters} masters, treasury ${d.treasury}c.`);
      }
      return;
    }
    const dues = Guilds.duesStatus(username);
    const mentor = Guilds.mentorOf(username);
    say(player, `Guild rank: ${mem.rank}${mem.suspended ? " (SUSPENDED — dues overdue)" : ""}. Certified maps: ${mem.certCount}. Dues ${dues.overdue ? "OVERDUE" : "paid"}.${mentor ? ` Mentored by ${mentor}.` : ""}`);
    return;
  }

  if (sub === "join") {
    if (!home) return say(player, "The guild needs to know your kingdom first.");
    const res = Guilds.joinGuild(username, home);
    if (!res.ok) {
      const why = {
        "not-cartographer": "Only registered cartographers may join — draft maps at the map shop first.",
        "already-member": "You are already a member.",
      }[res.reason] || res.reason;
      return say(player, `Could not join: ${why}.`);
    }
    say(player, `Welcome to the Grand Cartographers' Guild, apprentice ${username}. Dues are 25 coins a week; certify maps to rise.`);
    return;
  }

  if (sub === "leave") {
    if (Guilds.leaveGuild(username)) say(player, "You have left the guild. The hall will miss your charts.");
    else say(player, "You are not a member.");
    return;
  }

  if (sub === "dues") {
    const mem = Guilds.memberOf(username);
    if (!mem) return say(player, "You are not a member.");
    if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
      return say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
    }
    Guilds.creditTreasury(mem.kingdomId, Guilds.DUES_WEEKLY);
    Guilds.recordDuesPaid(username, Date.now());
    say(player, `Dues paid (${Guilds.DUES_WEEKLY} coins). The guild thanks you.`);
    return;
  }

  if (sub === "certify") {
    const mapId = String(args?.[1] ?? "");
    if (!mapId) return say(player, "Certify what? ::mapguild certify <mapId> (the map must be listed in the shop).");
    const mem = Guilds.memberOf(username);
    if (!mem) return say(player, "Only guild members may certify maps.");
    // Fee from the real inventory first — honest, no coins no certification.
    if (!takeCoins(player, Guilds.CERT_FEE)) {
      return say(player, `Certification costs ${Guilds.CERT_FEE} coins.`);
    }
    Guilds.creditTreasury(mem.kingdomId, Guilds.CERT_FEE);
    const res = Guilds.submitForCertification(username, mapId, mem.kingdomId);
    if (!res.ok) {
      // Refund the fee honestly on failure — the guild never keeps coins for nothing.
      giveCoins(player, Guilds.CERT_FEE);
      Guilds.debitTreasury(mem.kingdomId, Guilds.CERT_FEE);
      const why = {
        "not-listed": "That map is not listed in the guild's map shop.",
        "not-author": "Only the map's creator may submit it.",
        "already-certified": "That map is already certified (or awaiting review).",
        "quality-too-low": "The guild only certifies maps of quality 6 or better.",
        "suspended": "Your membership is suspended — pay your dues first.",
      }[res.reason] || res.reason;
      return say(player, `Certification failed: ${why}.`);
    }
    say(player, `Submitted for guild review (provisional grade ${res.provisionalGrade}). The seal will be struck at the next guild session.`);
    return;
  }

  if (sub === "bounties") {
    if (!home) return say(player, "The guild needs to know your kingdom first.");
    const list = Guilds.activeBounties(home);
    if (!list.length) return say(player, "No open survey bounties. The guild's charts are complete — for now.");
    say(player, `Open survey bounties (${list.length}):`);
    for (const b of list.slice(0, 8)) {
      say(player, `- ${b.targetType} chart [${b.id}] — reward ${b.reward} coins. Certify one after this posting to claim.`);
    }
    return;
  }

  if (sub === "post") {
    const mem = Guilds.memberOf(username);
    if (!mem) return say(player, "Only guild members may post survey bounties.");
    const type = String(args?.[1] ?? "").toLowerCase();
    const reward = Math.floor(Number(args?.[2]) || 0);
    if (!type || reward <= 0) return say(player, "Post what? ::mapguild post <world|city|dungeon|treasure> <reward>");
    // The sponsor funds the bounty from their own real coins: the coins go
    // into the guild treasury first, then postBounty locks them honestly.
    if (!takeCoins(player, reward)) return say(player, `You need ${reward} coins to fund that bounty.`);
    Guilds.creditTreasury(mem.kingdomId, reward);
    const posted = Guilds.postBounty(mem.kingdomId, type, reward);
    if (!posted.ok) {
      Guilds.debitTreasury(mem.kingdomId, reward);
      giveCoins(player, reward);
      return say(player, `Could not post: ${posted.reason}.`);
    }
    say(player, `Survey bounty posted: ${type} chart, ${reward} coins. Certify one to claim it.`);
    return;
  }

  if (sub === "claim") {
    const bountyId = String(args?.[1] ?? "");
    if (!bountyId) return say(player, "Claim what? ::mapguild claim <bountyId>");
    const res = Guilds.claimBounty(username, bountyId);
    if (!res.ok) {
      const why = {
        "no-proof": "You need a guild-certified chart of that type, certified after the bounty was posted.",
        "already-claimed": "That bounty is already claimed.",
        "expired": "That bounty has expired.",
        "wrong-kingdom": "That bounty belongs to another kingdom's guild.",
        "suspended": "Your membership is suspended — pay your dues first.",
      }[res.reason] || res.reason;
      return say(player, `Claim failed: ${why}.`);
    }
    giveCoins(player, res.reward);
    say(player, `Bounty claimed! ${res.reward} coins for your certified ${res.mapId}. The guild archive grows.`);
    return;
  }

  if (sub === "archive") {
    if (!home) return say(player, "The guild needs to know your kingdom first.");
    const entries = Guilds.archiveFor(home).slice(0, 8);
    if (!entries.length) return say(player, "The guild archive is empty. Certify maps to fill its shelves.");
    say(player, `Guild archive — ${Guilds.archiveFor(home).length} sealed charts (prestige ${Guilds.archivePrestige(home)}/100):`);
    for (const e of entries) {
      say(player, `- [${e.grade}] ${e.type} by ${e.creator} (quality ${e.quality})`);
    }
    return;
  }

  if (sub === "apprentice") {
    const apprentice = String(args?.[1] ?? "").trim();
    if (!apprentice) return say(player, "Take whom? ::mapguild apprentice <name>");
    const res = Guilds.takeApprentice(username, apprentice);
    if (!res.ok) {
      const why = {
        "not-master": "Only guildmasters may take apprentices.",
        "not-apprentice": "They must be a guild apprentice first.",
        "wrong-kingdom": "They belong to another kingdom's guild.",
        "master-busy": "You already mentor an apprentice.",
        "already-mentored": "They already have a mentor.",
      }[res.reason] || res.reason;
      return say(player, `Could not take apprentice: ${why}.`);
    }
    say(player, `${apprentice} is now your apprentice. Their certification fees are waived; teach them well.`);
    return;
  }

  say(player, MAPGUILD_USAGE);
}

module.exports = { onMapGuildCommand, MAPGUILD_USAGE };
