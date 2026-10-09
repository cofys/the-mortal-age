"use strict";

/**
 * CitizenArtGuildEvents — player-facing Artists' Guild: the ::artguild command.
 *
 * Mirrors the ::musicguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit
 * artworks for guild certification, report suspected forgeries, vote on
 * tribunal cases, post patronage bounties, and arrange mentorship. Bots
 * are rejected: citizens act through the brain and the life tick, not
 * the command.
 */

const Guilds = require("./lib/CitizenArtGuilds");

const COINS_ID = 995;

const ARTGUILD_USAGE =
  "::artguild [status|join|leave|dues|code|certify <artworkId>|seals|report <title>|cases|vote <caseId> <guilty|innocent>|palette|patron <medium> <coins>|bounties|claim <bountyId> <certId>|contribute <coins>|school|apprentice <name>]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    // Engine truth: Player#isPlayerBot() (server/src/main/typescript/elvarg/game/entity/impl/player/Player.ts:1084)
    // returns true for bot entities. The `?? false` fallback is deliberate: gate
    // call sites always receive a live command entity, so isPlayerBot() is always
    // callable there; the fallback preserves the legacy pass-through for anything
    // that isn't a known bot instead of silently blocking a new class of callers.
    return !(player?.isPlayerBot?.() ?? false);
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
    // Canonical: ItemContainer.getAmount(id), deleteNumber/delete(id, amount).
    // There is no inv.count(id) and no inv.remove(id, amount).
    const has = typeof inv.getAmount === "function" ? inv.getAmount(COINS_ID) : 0;
    if (has < amount) return false;
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    else return false;
    // Honest: the balance must actually have moved, or the fee wasn't taken.
    return (inv.getAmount?.(COINS_ID) ?? 0) === has - amount;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    // Canonical id/amount form is adds(id, amount): add(item, refresh) takes
    // an Item object, not (id, amount). The wrong signature would throw (or
    // corrupt) and silently break honest refunds.
    if (typeof inv.adds !== "function") return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    inv.adds(COINS_ID, amount);
    // Honest: the balance must actually have moved, or the prize wasn't paid.
    return (inv.getAmount?.(COINS_ID) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

function onArtGuildCommand(player, args) {
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
        say(player, "No Artists' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      const insp = Guilds.inspectionFor(kingdomId);
      say(player, `Artists' Guild — ${desc.memberCount} members, ` +
        `${desc.certified} certified artworks. Atelier inspection: ${insp.score}/100. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}.` +
        (m ? ` You are ${m.rank === "apprentice" ? "an" : "a"} ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Artists' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You have left the Artists' Guild." : `Could not leave: ${res.reason}.`);
      return;
    }
    case "dues": {
      const m = Guilds.memberOf(username);
      if (!m) { say(player, "You are not a guild member."); return; }
      if ((m.duesPaidUntilMs || 0) > Date.now()) {
        say(player, "Your dues are paid up.");
        return;
      }
      if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
        say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
        return;
      }
      Guilds.recordDuesPayment(username, Date.now());
      say(player, "Dues paid. Thank you for supporting the guild.");
      return;
    }
    case "code": {
      say(player, "The Artists' Code: (1) Honor the craft — never claim another's work. " +
        "(2) Work true — no false provenance for coin. (3) Teach the young. " +
        "(4) Keep your studio. (5) Pay your dues.");
      return;
    }
    case "certify": {
      // ::artguild certify <artworkId>
      const artworkId = rest[0];
      if (!artworkId) {
        say(player, "Usage: ::artguild certify <artworkId>");
        return;
      }
      const m = Guilds.memberOf(username);
      const mentored = m && Guilds.load().mentorships[username.toLowerCase()];
      const fee = mentored ? 0 : Guilds.CERT_FEE;
      if (fee > 0 && !takeCoins(player, fee)) {
        say(player, `Certification costs ${fee} coins.`);
        return;
      }
      const res = Guilds.certifyArtwork(kingdomId, username, artworkId);
      if (!res.ok) {
        // Refund the fee on failure — honest economics.
        if (fee > 0) giveCoins(player, fee);
        say(player, `Certification failed: ${res.reason}.`);
        return;
      }
      say(player, `Artwork certified! Grade ${res.grade}. ` +
        (res.bountyPaid > 0 ? `Bounty paid: ${res.bountyPaid} coins.` : "") +
        (res.bountyOwed > 0 ? ` Bounty owed: ${res.bountyOwed} coins (the guild will pay when funds allow).` : ""));
      return;
    }
    case "seals": {
      const grade = Guilds.gradeFor(username);
      if (!grade) { say(player, "You have no certified artworks."); return; }
      say(player, `Your best certification grade: ${grade}.`);
      return;
    }
    case "report": {
      const title = rest.join(" ");
      if (!title) { say(player, "Usage: ::artguild report <artwork title>"); return; }
      const res = Guilds.reportForgery(kingdomId, username, title);
      say(player, res.ok ? `Forgery case opened: ${res.caseId}. Artists will vote.`
        : `Could not open case: ${res.reason}.`);
      return;
    }
    case "cases": {
      const st = Guilds.load();
      const open = Object.values(st.cases || {}).filter((c) => c.kingdomId === kingdomId && c.status === "open");
      if (!open.length) { say(player, "No open tribunal cases."); return; }
      say(player, open.map((c) => `${c.id}: ${c.accused} accused of forging "${c.title}" (${Object.keys(c.votes).length} votes)`).join(" | "));
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::artguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteOnCase(caseId, username, verdict.toLowerCase());
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "palette": {
      const g = Guilds.guildOf(kingdomId);
      say(player, g ? "The golden palette is awarded quarterly to the most-certified member." : "No guild hall here yet.");
      return;
    }
    case "patron": {
      // ::artguild patron <medium> <coins> — sponsor a patronage bounty.
      const [medium, coinsRaw] = rest;
      const amount = parseInt(coinsRaw, 10);
      if (!medium || !amount || amount < 100) {
        say(player, "Usage: ::artguild patron <painting|sculpture|writing> <coins, min 100>");
        return;
      }
      if (!takeCoins(player, amount)) {
        say(player, `You need ${amount} coins to post a patronage bounty.`);
        return;
      }
      const res = Guilds.postBounty(kingdomId, username, medium, amount);
      if (!res.ok) {
        giveCoins(player, amount); // refund on failure
        say(player, `Could not post bounty: ${res.reason}.`);
        return;
      }
      Guilds.creditTreasury(kingdomId, amount); // the guild holds the bounty
      say(player, `Patronage bounty posted: ${amount} coins for a certified ${medium}. Bounty id: ${res.bountyId}.`);
      return;
    }
    case "bounties": {
      const st = Guilds.load();
      const open = Object.values(st.bounties || {}).filter((b) => b.kingdomId === kingdomId && b.status === "open");
      if (!open.length) { say(player, "No open patronage bounties."); return; }
      say(player, open.map((b) => `${b.id}: ${b.amount} coins for a certified ${b.medium} (sponsor: ${b.sponsor})`).join(" | "));
      return;
    }
    case "claim": {
      // ::artguild claim <bountyId> <certId>
      const [bountyId, certId] = rest;
      if (!bountyId || !certId) { say(player, "Usage: ::artguild claim <bountyId> <certId>"); return; }
      const res = Guilds.claimBounty(bountyId, username, certId);
      if (!res.ok) {
        say(player, `Could not claim: ${res.reason}.`);
        return;
      }
      const pay = Guilds.payBounty(bountyId);
      say(player, pay.ok
        ? `Bounty claimed! ${pay.amount} coins paid to your bank account.` +
          (pay.owed > 0 ? ` ${pay.owed} coins still owed (the guild will pay when funds allow).` : "")
        : `Claim recorded but payment failed: ${pay.reason}.`);
      return;
    }
    case "contribute": {
      const amount = parseInt(rest[0], 10);
      if (!amount || amount <= 0) { say(player, "Usage: ::artguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) { say(player, "You don't have that many coins."); return; }
      Guilds.contributeToFund(kingdomId, amount);
      say(player, `Thank you! ${amount} coins added to the patron fund.`);
      return;
    }
    case "school": {
      say(player, "The art school: master artists teach apprentices. Attend guild sessions to earn training credits.");
      return;
    }
    case "apprentice": {
      const novice = rest.join(" ");
      if (!novice) { say(player, "Usage: ::artguild apprentice <name>"); return; }
      const res = Guilds.takeApprentice(username, novice);
      say(player, res.ok ? `${novice} is now your apprentice.` : `Could not take apprentice: ${res.reason}.`);
      return;
    }
    default:
      say(player, ARTGUILD_USAGE);
      return;
  }
}

module.exports = { onArtGuildCommand, ARTGUILD_USAGE , giveCoins, takeCoins };
