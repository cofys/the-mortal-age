"use strict";

/**
 * CitizenLibrarianGuildEvents — player-facing Librarians' Guild: the ::libguild command.
 *
 * Mirrors the ::artguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit
 * books for guild certification, report suspected plagiarism, vote on
 * tribunal cases, propose and vote on Restricted Index entries, seal
 * archives, post scriptorium bounties, and arrange mentorship. Bots
 * are rejected: citizens act through the brain and the life tick, not
 * the command.
 */

const Guilds = require("./lib/CitizenLibrarianGuilds");

const COINS_ID = 995;

const LIBGUILD_USAGE =
  "::libguild [status|join|leave|dues|code|certify <bookId>|seals|report <title>|cases|vote <caseId> <guilty|innocent>|quill|scriptorium <subject> <coins>|bounties|claim <bountyId> <certId>|contribute <coins>|school|apprentice <name>|seal|index <title>|voteindex <title> <restrict|allow>|indexlist]";

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
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    if (before < amount) return false;
    // Canonical engine API: ItemContainer.deleteNumber(id, amount).
    // There is no inv.remove(id, amount) and no inv.count(id).
    inv.deleteNumber?.(COINS_ID, amount);
    // Honest: the balance must actually have moved, or the fee wasn't taken.
    return (inv.getAmount?.(COINS_ID) ?? 0) === before - amount;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    // Canonical: adds(id, amount). add(item, refresh) takes an Item object —
    // add(id, amount) throws, so prize money silently never arrived.
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    inv.adds?.(COINS_ID, amount);
    // Honest: the balance must actually have moved, or the prize wasn't paid.
    return (inv.getAmount?.(COINS_ID) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

function onLibrarianGuildCommand(player, args) {
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
        say(player, "No Librarians' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      const insp = Guilds.inspectionFor(kingdomId);
      say(player, `Librarians' Guild — ${desc.memberCount} members, ` +
        `${desc.certified} certified books. Collection inspection: ${insp.score}/100. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}.` +
        (desc.sealed ? " Archives sealed as authentic." : "") +
        (m ? ` You are ${m.rank === "archivist" ? "an" : "a"} ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Librarians' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You have left the Librarians' Guild." : `Could not leave: ${res.reason}.`);
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
      say(player, "The Librarians' Code: (1) Guard the stacks — never claim another's work. " +
        "(2) Write true — no false provenance for coin. (3) Teach the young. " +
        "(4) Keep the collection. (5) Pay your dues.");
      return;
    }
    case "certify": {
      // ::libguild certify <bookId>
      const bookId = rest[0];
      if (!bookId) {
        say(player, "Usage: ::libguild certify <bookId>");
        return;
      }
      const m = Guilds.memberOf(username);
      const mentored = m && Guilds.load().mentorships[username.toLowerCase()];
      const fee = mentored ? 0 : Guilds.CERT_FEE;
      if (fee > 0 && !takeCoins(player, fee)) {
        say(player, `Certification costs ${fee} coins.`);
        return;
      }
      const res = Guilds.certifyBook(kingdomId, username, bookId);
      if (!res.ok) {
        // Refund the fee on failure — honest economics.
        if (fee > 0) giveCoins(player, fee);
        say(player, `Certification failed: ${res.reason}.`);
        return;
      }
      say(player, `Book certified! Grade ${res.grade}. ` +
        (res.bountyPaid > 0 ? `Bounty paid: ${res.bountyPaid} coins.` : "") +
        (res.bountyOwed > 0 ? ` Bounty owed: ${res.bountyOwed} coins (the guild will pay when funds allow).` : ""));
      return;
    }
    case "seals": {
      const grade = Guilds.gradeFor(username);
      if (!grade) { say(player, "You have no certified books."); return; }
      say(player, `Your best certification grade: ${grade}.`);
      return;
    }
    case "report": {
      const title = rest.join(" ");
      if (!title) { say(player, "Usage: ::libguild report <book title>"); return; }
      const res = Guilds.reportPlagiarism(kingdomId, username, title);
      say(player, res.ok ? `Plagiarism case opened: ${res.caseId}. Librarians will vote.`
        : `Could not open case: ${res.reason}.`);
      return;
    }
    case "cases": {
      const st = Guilds.load();
      const open = Object.values(st.cases || {}).filter((c) => c.kingdomId === kingdomId && c.status === "open");
      if (!open.length) { say(player, "No open tribunal cases."); return; }
      say(player, open.map((c) => `${c.id}: ${c.accused} accused of plagiarizing "${c.title}" (${Object.keys(c.votes).length} votes)`).join(" | "));
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::libguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteOnCase(caseId, username, verdict.toLowerCase());
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "quill": {
      const g = Guilds.guildOf(kingdomId);
      say(player, g ? "The golden quill is awarded quarterly to the most-certified member." : "No guild hall here yet.");
      return;
    }
    case "scriptorium": {
      // ::libguild scriptorium <subject> <coins> — sponsor a scriptorium bounty.
      const [subject, coinsRaw] = rest;
      const amount = parseInt(coinsRaw, 10);
      if (!subject || !amount || amount < 100) {
        say(player, "Usage: ::libguild scriptorium <subject> <coins, min 100>");
        return;
      }
      if (!takeCoins(player, amount)) {
        say(player, `You need ${amount} coins to post a scriptorium bounty.`);
        return;
      }
      const res = Guilds.postBounty(kingdomId, username, subject, amount);
      if (!res.ok) {
        giveCoins(player, amount); // refund on failure
        say(player, `Could not post bounty: ${res.reason}.`);
        return;
      }
      Guilds.creditTreasury(kingdomId, amount); // the guild holds the bounty
      say(player, `Scriptorium bounty posted: ${amount} coins for a certified book on ${subject}. Bounty id: ${res.bountyId}.`);
      return;
    }
    case "bounties": {
      const st = Guilds.load();
      const open = Object.values(st.bounties || {}).filter((b) => b.kingdomId === kingdomId && b.status === "open");
      if (!open.length) { say(player, "No open scriptorium bounties."); return; }
      say(player, open.map((b) => `${b.id}: ${b.amount} coins for a certified book on ${b.subject} (sponsor: ${b.sponsor})`).join(" | "));
      return;
    }
    case "claim": {
      // ::libguild claim <bountyId> <certId>
      const [bountyId, certId] = rest;
      if (!bountyId || !certId) { say(player, "Usage: ::libguild claim <bountyId> <certId>"); return; }
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
      if (!amount || amount <= 0) { say(player, "Usage: ::libguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) { say(player, "You don't have that many coins."); return; }
      Guilds.contributeToFund(kingdomId, amount);
      say(player, `Thank you! ${amount} coins added to the scriptorium fund.`);
      return;
    }
    case "school": {
      say(player, "The scriptorium school: archivists teach pages. Attend guild sessions to earn training credits.");
      return;
    }
    case "apprentice": {
      const novice = rest.join(" ");
      if (!novice) { say(player, "Usage: ::libguild apprentice <name>"); return; }
      const res = Guilds.takeApprentice(username, novice);
      say(player, res.ok ? `${novice} is now your apprentice.` : `Could not take apprentice: ${res.reason}.`);
      return;
    }
    case "seal": {
      // ::libguild seal — an archivist certifies the kingdom's archives.
      const res = Guilds.sealArchives(kingdomId, username);
      say(player, res.ok ? `Archives sealed as authentic! ${res.archiveCount} records covering ${res.subjects.length} subjects.`
        : `Could not seal archives: ${res.reason}.`);
      return;
    }
    case "index": {
      // ::libguild index <title> — propose a book for the Restricted Index.
      const title = rest.join(" ");
      if (!title) { say(player, "Usage: ::libguild index <book title>"); return; }
      const res = Guilds.proposeRestriction(kingdomId, username, title);
      say(player, res.ok ? `Proposed for the Restricted Index. Librarians will vote.`
        : `Could not propose: ${res.reason}.`);
      return;
    }
    case "voteindex": {
      const verdict = rest[rest.length - 1];
      const title = rest.slice(0, -1).join(" ");
      if (!title || !verdict) { say(player, "Usage: ::libguild voteindex <book title> <restrict|allow>"); return; }
      const res = Guilds.voteOnRestriction(title, username, verdict.toLowerCase());
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "indexlist": {
      const list = Guilds.restrictedList(kingdomId);
      if (!list.length) { say(player, "The Restricted Index is empty."); return; }
      say(player, "Restricted Index: " + list.map((e) => `"${e.title}"`).join(", "));
      return;
    }
    default:
      say(player, LIBGUILD_USAGE);
      return;
  }
}

module.exports = { onLibrarianGuildCommand, LIBGUILD_USAGE , giveCoins, takeCoins };
