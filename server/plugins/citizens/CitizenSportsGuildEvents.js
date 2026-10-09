"use strict";

/**
 * CitizenSportsGuildEvents — player-facing Athletes' Guild: the ::sportsguild command.
 *
 * Mirrors the ::stageguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit records
 * for guild certification, report suspected doping, vote on tribunal cases,
 * sponsor and claim training camps, and arrange mentorship. Bots are
 * rejected: citizens act through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenSportsGuilds");

const COINS_ID = 995;

const SPORTSGUILD_USAGE =
  "::sportsguild [status|join|leave|dues|code|certify <sport>|seals|report <sport>|cases|vote <caseId> <guilty|innocent>|camps|post <targetKingdom> <bounty>|claim <campId>|laurel|contribute <coins>|school|apprentice <name>]";

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
    const { kingdomIdOf } = require("./brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
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

function onSportsGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const [sub, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
  const cmd = (sub || "status").toLowerCase();

  if (!kingdomId && cmd !== "code") {
    say(player, "The guild needs to know your kingdom first.");
    return;
  }

  switch (cmd) {
    case "status": {
      const desc = Guilds.describe(kingdomId);
      if (!desc.exists) {
        say(player, "No Athletes' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      say(player, `Athletes' Guild — ${desc.memberCount} members (${desc.gamesmasters} gamesmasters), ` +
        `${desc.sealed} certified records, ${desc.openCamps} open training camps. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}.` +
        (m ? ` You are a ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Athletes' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You left the Athletes' Guild." : `Could not leave: ${res.reason}.`);
      return;
    }
    case "dues": {
      const m = Guilds.memberOf(username);
      if (!m) { say(player, "You are not a member."); return; }
      if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
        say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
        return;
      }
      const res = Guilds.recordDuesPayment(username, Date.now());
      say(player, res.ok ? "Dues paid. The guild thanks you." : "Could not record dues.");
      return;
    }
    case "code": {
      say(player, "The Sports Code: " + Guilds.SPORTS_CODE.join(" "));
      return;
    }
    case "certify": {
      const sport = (rest[0] || "").toLowerCase();
      if (!sport) { say(player, "Usage: ::sportsguild certify <sport>"); return; }
      const sub2 = Guilds.submitRecord(username, kingdomId, sport, Date.now());
      if (!sub2.ok) { say(player, `Could not submit: ${sub2.reason}.`); return; }
      if (sub2.fee > 0 && !takeCoins(player, sub2.fee)) {
        say(player, `Certification costs ${sub2.fee} coins.`);
        return;
      }
      const res = Guilds.settleCertification(kingdomId, sport, Date.now());
      say(player, res.ok
        ? `Record certified — grade ${res.grade}! Bounty: ${res.paid} coins paid${res.owed ? `, ${res.owed} owed` : ""}${res.doubled ? " (home-kingdom double)" : ""}.`
        : `Certification failed: ${res.reason}.`);
      return;
    }
    case "seals": {
      const desc = Guilds.describe(kingdomId);
      say(player, `${desc.sealed} records carry the guild seal in this kingdom.`);
      return;
    }
    case "report": {
      const sport = (rest[0] || "").toLowerCase();
      if (!sport) { say(player, "Usage: ::sportsguild report <sport>"); return; }
      const rec = Guilds.realRecordFor(kingdomId, sport);
      if (!rec) { say(player, "No record stands for that sport here."); return; }
      const res = Guilds.reportDoping(kingdomId, rec.holder, "player-report", username);
      say(player, res.ok ? `Doping case opened against ${rec.holder} (case ${res.id}).` : `Could not report: ${res.reason}.`);
      return;
    }
    case "cases": {
      const s = Guilds.serialize();
      const open = Object.values(s.cases).filter((c) => c.kingdomId === kingdomId && !c.settled);
      say(player, open.length ? open.map((c) => `${c.id}: ${c.accused} (${c.kind})`).join("; ") : "No open doping cases.");
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::sportsguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteCase(caseId, username, /^guilty$/i.test(verdict));
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "camps": {
      const camps = Guilds.campsFor(kingdomId);
      say(player, camps.length
        ? camps.map((c) => `${c.id}: ${c.sponsor} offers ${c.bounty} coins to train here`).join("; ")
        : "No open training camps.");
      return;
    }
    case "post": {
      const [targetKingdom, bountyStr] = rest;
      const bounty = parseInt(bountyStr, 10);
      if (!targetKingdom || !Number.isFinite(bounty)) { say(player, "Usage: ::sportsguild post <targetKingdom> <bounty>"); return; }
      if (!takeCoins(player, bounty)) { say(player, `You need ${bounty} coins to post the bounty.`); return; }
      const res = Guilds.postCamp(username, targetKingdom, bounty);
      say(player, res.ok ? `Training camp posted (${res.id}).` : `Could not post: ${res.reason}.`);
      return;
    }
    case "claim": {
      const campId = rest[0];
      if (!campId) { say(player, "Usage: ::sportsguild claim <campId>"); return; }
      const res = Guilds.claimCamp(campId, username);
      say(player, res.ok ? `Camp claimed — ${res.bounty} coins bounty.` : `Could not claim: ${res.reason}.`);
      return;
    }
    case "laurel": {
      const desc = Guilds.describe(kingdomId);
      say(player, desc.exists ? `Golden laurel prestige: ${desc.prestige}.` : "No guild here yet.");
      return;
    }
    case "contribute": {
      const amount = parseInt(rest[0], 10);
      if (!Number.isFinite(amount) || amount <= 0) { say(player, "Usage: ::sportsguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) { say(player, `You need ${amount} coins.`); return; }
      const g = Guilds.ensureGuild(kingdomId);
      g.treasury += amount;
      say(player, `Contributed ${amount} coins to the guild treasury.`);
      return;
    }
    case "school": {
      const res = Guilds.holdClass(kingdomId, username);
      say(player, res.ok ? `Class held — ${res.taught} rookies taught.` : `Could not hold class: ${res.reason}.`);
      return;
    }
    case "apprentice": {
      const rookie = rest.join(" ");
      if (!rookie) { say(player, "Usage: ::sportsguild apprentice <name>"); return; }
      const res = Guilds.takeApprentice(username, rookie);
      say(player, res.ok ? `${rookie} is now your apprentice.` : `Could not mentor: ${res.reason}.`);
      return;
    }
    default:
      say(player, SPORTSGUILD_USAGE);
  }
}

module.exports = { onSportsGuildCommand, SPORTSGUILD_USAGE };
