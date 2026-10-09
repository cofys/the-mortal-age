"use strict";

/**
 * CitizenStageGuildEvents — player-facing Players' Guild: the ::stageguild command.
 *
 * Mirrors the ::stage / ::digguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit plays for
 * guild certification, report suspected plagiarism, vote on tribunal cases,
 * sponsor and claim touring circuits, and arrange mentorship. Bots are
 * rejected: citizens act through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenStageGuilds");

const COINS_ID = 995;

const STAGEGUILD_USAGE =
  "::stageguild [status|join|leave|dues|code|certify <playId>|seals|report <playId>|cases|vote <caseId> <guilty|innocent>|circuits|post <targetKingdom> <bounty>|claim <circuitId> <troupe>|laurels|contribute <coins>|school|apprentice <name>]";

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

// Best-effort honest refund: canonical adds(id, amount). The old add(id,
// amount) threw, so "refunded" fees were silently lost.
function refundCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return;
    inv.adds?.(COINS_ID, amount);
  } catch { /* best-effort */ }
}

function onStageGuildCommand(player, args) {
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
        say(player, "No Players' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      say(player, `Players' Guild — ${desc.memberCount} members (${desc.stagemasters} stagemasters), ` +
        `${desc.certified} certified plays, ${desc.openCircuits} open touring circuits. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}.` +
        (m ? ` You are a ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Players' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You left the Players' Guild." : `Could not leave: ${res.reason}.`);
      return;
    }
    case "dues": {
      const m = Guilds.memberOf(username);
      if (!m) { say(player, "You are not a member."); return; }
      if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
        say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
        return;
      }
      Guilds.recordDuesPayment(username);
      say(player, "Dues paid. The guild thanks you.");
      return;
    }
    case "code": {
      say(player, "Stage code: " + Guilds.STAGE_CODE.join(" "));
      return;
    }
    case "certify": {
      const playId = rest[0];
      if (!playId) { say(player, "Usage: ::stageguild certify <playId>"); return; }
      if (!takeCoins(player, Guilds.CERT_FEE)) {
        say(player, `Certification costs ${Guilds.CERT_FEE} coins.`);
        return;
      }
      const res = Guilds.submitForCertification(playId, username, kingdomId);
      if (!res.ok) {
        // honest refund: the play failed verification, fee comes back
        refundCoins(player, Guilds.CERT_FEE);
        say(player, `Could not certify: ${res.reason}. Fee refunded.`);
        return;
      }
      const settled = Guilds.settleCertification(playId);
      if (settled.ok) {
        say(player, `Certified "${settled.seal.title}" — grade ${settled.grade}${settled.doubled ? " (home triumph, double bounty)" : ""}. ` +
          (settled.paid > 0 ? `Bounty paid: ${settled.paid} coins.` : settled.owed > 0 ? `Bounty owed: ${settled.owed} coins (guild is broke).` : ""));
      } else {
        say(player, `Queued for certification: ${res.play.title}.`);
      }
      return;
    }
    case "seals": {
      const desc = Guilds.describe(kingdomId);
      say(player, `${desc.certified} certified plays in the guild archive.`);
      return;
    }
    case "report": {
      const playId = rest[0];
      if (!playId) { say(player, "Usage: ::stageguild report <playId>"); return; }
      const res = Guilds.reportPlagiarism(kingdomId, playId, username);
      say(player, res.ok ? `Plagiarism case ${res.case.id} opened. Stagemasters will vote.`
        : `Could not open a case: ${res.reason}.`);
      return;
    }
    case "cases": {
      const open = Object.values(Guilds.load().cases).filter((c) =>
        c.status === "open" && String(c.kingdomId).toLowerCase() === String(kingdomId).toLowerCase());
      if (!open.length) { say(player, "No open tribunal cases."); return; }
      say(player, open.map((c) => `${c.id}: ${c.accused} accused over "${c.playId}" (${Object.keys(c.votes || {}).length} votes)`).join(" | "));
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::stageguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteOnCase(caseId, username, verdict);
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "circuits": {
      const circuits = Guilds.circuitsFor(kingdomId, true);
      if (!circuits.length) { say(player, "No open touring circuits."); return; }
      say(player, circuits.map((c) => `${c.id}: tour ${c.targetKingdom}, bounty ${c.bounty} (sponsor: ${c.sponsor})`).join(" | "));
      return;
    }
    case "post": {
      const [target, bountyRaw] = rest;
      const bounty = Math.floor(Number(bountyRaw) || 0);
      if (!target || !bounty) { say(player, "Usage: ::stageguild post <targetKingdom> <bounty>"); return; }
      if (!takeCoins(player, bounty)) {
        say(player, `You need ${bounty} coins to post the bounty.`);
        return;
      }
      const res = Guilds.postCircuit(kingdomId, target, username, bounty);
      if (!res.ok) {
        refundCoins(player, bounty);
        say(player, `Could not post: ${res.reason}. Coins refunded.`);
        return;
      }
      say(player, `Circuit ${res.circuit.id} posted: ${bounty} coins for a troupe touring ${target}.`);
      return;
    }
    case "claim": {
      const [circuitId, ...troupeParts] = rest;
      const troupeName = troupeParts.join(" ");
      if (!circuitId || !troupeName) { say(player, "Usage: ::stageguild claim <circuitId> <troupe name>"); return; }
      const res = Guilds.claimCircuit(circuitId, troupeName, username);
      say(player, res.ok ? `${troupeName} claimed the circuit — ${res.bounty} coins to their treasury.`
        : `Could not claim: ${res.reason}.`);
      return;
    }
    case "laurels": {
      const laurels = Guilds.load().laurels.filter((l) =>
        String(l.kingdomId).toLowerCase() === String(kingdomId).toLowerCase()).slice(-3).reverse();
      if (!laurels.length) { say(player, "No critics' choice laurels awarded yet."); return; }
      say(player, laurels.map((l) => `${l.troupe} (${l.fiveStarCount} acclaimed shows)`).join(" | "));
      return;
    }
    case "contribute": {
      const amount = Math.floor(Number(rest[0]) || 0);
      if (!amount || amount <= 0) { say(player, "Usage: ::stageguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) {
        say(player, `You need ${amount} coins to contribute.`);
        return;
      }
      Guilds.contribute(username, amount, kingdomId, false);
      say(player, `Contributed ${amount} coins to the guild treasury.`);
      return;
    }
    case "school": {
      const res = Guilds.tryPromote(username);
      say(player, res.ok ? `Promoted to ${res.rank}.` : `Not yet: ${res.reason}. (Seek a stagemaster's class.)`);
      return;
    }
    case "apprentice": {
      const master = rest.join(" ");
      if (!master) { say(player, "Usage: ::stageguild apprentice <stagemaster name>"); return; }
      const res = Guilds.takeMentorship(master, username);
      say(player, res.ok ? `${master} took you as apprentice. Certification fees waived.` : `Could not arrange: ${res.reason}.`);
      return;
    }
    default:
      say(player, STAGEGUILD_USAGE);
  }
}

module.exports = { onStageGuildCommand, STAGEGUILD_USAGE, takeCoins, refundCoins };
