"use strict";

/**
 * CitizenMusicGuildEvents — player-facing Minstrels' Guild: the ::musicguild command.
 *
 * Mirrors the ::weaverguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit
 * performances for guild certification, report suspected song theft, vote on
 * tribunal cases, and arrange mentorship. Bots are rejected: citizens act
 * through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenMusicGuilds");

const COINS_ID = 995;

const MUSICGUILD_USAGE =
  "::musicguild [status|join|leave|dues|code|certify <concertId> <title>|seals|report <title>|cases|vote <caseId> <guilty|innocent>|lyre|contribute <coins>|school|apprentice <name>]";

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

function onMusicGuildCommand(player, args) {
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
        say(player, "No Minstrels' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      const insp = Guilds.inspectionFor(kingdomId);
      say(player, `Minstrels' Guild — ${desc.memberCount} members, ` +
        `${desc.certified} certified performances. Harmony inspection: ${insp.score}/100. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}.` +
        (m ? ` You are a ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Minstrels' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You have left the Minstrels' Guild." : `Could not leave: ${res.reason}.`);
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
      say(player, "The Minstrels' Code: (1) Honor the music — never claim another's song. " +
        "(2) Play true — no false notes for coin. (3) Teach the young. " +
        "(4) Keep your instrument. (5) Pay your dues.");
      return;
    }
    case "certify": {
      // ::musicguild certify <concertId> <title...>
      const concertId = rest[0];
      const title = rest.slice(1).join(" ");
      if (!concertId || !title) {
        say(player, "Usage: ::musicguild certify <concertId> <title>");
        return;
      }
      // Validate BEFORE touching the player's coins: certifyPerformance
      // creates the certification and pays the bounty, so a failed
      // validation after the fee was taken would silently eat the coins.
      const pre = Guilds.canCertify(kingdomId, username, concertId);
      if (!pre.ok) {
        say(player, `Certification failed: ${pre.reason}.`);
        return;
      }
      if (pre.fee > 0 && !takeCoins(player, pre.fee)) {
        say(player, `Certification costs ${pre.fee} coins.`);
        return;
      }
      const res = Guilds.certifyPerformance(kingdomId, username, concertId, title);
      if (!res.ok) {
        // Unreachable in the same tick — the pre-flight above already
        // passed — but stay honest if the ledger ever disagrees.
        say(player, `Certification failed: ${res.reason}.`);
        return;
      }
      // The guild already deducted the bounty from its reserves — actually
      // deliver it to the musician. Only say "Bounty paid" when the coins
      // really landed in their inventory.
      let bountyLine = "";
      let owedLine = "";
      if (res.bountyPaid > 0 && giveCoins(player, res.bountyPaid)) {
        bountyLine = `Bounty paid: ${res.bountyPaid} coins.`;
        if (res.bountyOwed > 0) {
          owedLine = ` Bounty owed: ${res.bountyOwed} coins (the guild will pay when funds allow).`;
        }
      } else if (res.bountyPaid > 0) {
        // The credit failed: park the deducted coins back in the guild's
        // reserves and re-record the bounty as owed — never claim a payment
        // that never happened, never invent coins. The life tick retries
        // delivery to the musician's bank account.
        const refund = Guilds.refundCertBounty(res.certId, res.bountyPaid,
          res.bountyPaidFromTreasury, res.bountyPaidFromFund);
        const owedTotal = refund.ok ? refund.bountyOwed : res.bountyOwed + res.bountyPaid;
        bountyLine = `Bounty of ${res.bountyPaid} coins could not be delivered to you — recorded as owed.`;
        owedLine = ` Total bounty owed: ${owedTotal} coins (the guild will pay it to your bank account).`;
      } else if (res.bountyOwed > 0) {
        owedLine = ` Bounty owed: ${res.bountyOwed} coins (the guild will pay when funds allow).`;
      }
      say(player, `Performance certified! Grade ${res.grade}. ` + bountyLine + owedLine);
      return;
    }
    case "seals": {
      const grade = Guilds.gradeFor(username);
      if (!grade) { say(player, "You have no certified performances."); return; }
      say(player, `Your best certification grade: ${grade}.`);
      return;
    }
    case "report": {
      const title = rest.join(" ");
      if (!title) { say(player, "Usage: ::musicguild report <song title>"); return; }
      const res = Guilds.reportPlagiarism(kingdomId, username, title);
      say(player, res.ok ? `Plagiarism case opened: ${res.caseId}. Minstrels will vote.`
        : `Could not open case: ${res.reason}.`);
      return;
    }
    case "cases": {
      const st = Guilds.load();
      const open = Object.values(st.cases || {}).filter((c) => c.kingdomId === kingdomId && c.status === "open");
      if (!open.length) { say(player, "No open tribunal cases."); return; }
      say(player, open.map((c) => `${c.id}: ${c.accused} accused of stealing "${c.title}" (${Object.keys(c.votes).length} votes)`).join(" | "));
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::musicguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteOnCase(caseId, username, verdict.toLowerCase());
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "lyre": {
      const g = Guilds.guildOf(kingdomId);
      say(player, g ? "The golden lyre is awarded quarterly to the most-certified member." : "No guild hall here yet.");
      return;
    }
    case "contribute": {
      const amount = parseInt(rest[0], 10);
      if (!amount || amount <= 0) { say(player, "Usage: ::musicguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) { say(player, "You don't have that many coins."); return; }
      Guilds.contributeToFund(kingdomId, amount);
      say(player, `Thank you! ${amount} coins added to the instrument fund.`);
      return;
    }
    case "school": {
      say(player, "The music school: maestro masters teach novices. Attend guild sessions to earn training credits.");
      return;
    }
    case "apprentice": {
      const novice = rest.join(" ");
      if (!novice) { say(player, "Usage: ::musicguild apprentice <name>"); return; }
      const res = Guilds.takeApprentice(username, novice);
      say(player, res.ok ? `${novice} is now your apprentice.` : `Could not take apprentice: ${res.reason}.`);
      return;
    }
    default:
      say(player, MUSICGUILD_USAGE);
      return;
  }
}

module.exports = { onMusicGuildCommand, MUSICGUILD_USAGE , giveCoins, takeCoins };
