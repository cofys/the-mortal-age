"use strict";

/**
 * CitizenWeaverGuildEvents — player-facing Weavers' Guild: the ::weaverguild command.
 *
 * Mirrors the ::cookguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit
 * collections for guild certification, report suspected knockoffs, vote on
 * tribunal cases, and arrange mentorship. Bots are rejected: citizens act
 * through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenWeaverGuilds");

const COINS_ID = 995;

const WEAVERGUILD_USAGE =
  "::weaverguild [status|join|leave|dues|code|certify <collectionId>|seals|report <designer>|inspect|cases|vote <caseId> <guilty|innocent>|needle|contribute <coins>|school|apprentice <name>]";

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

function onWeaverGuildCommand(player, args) {
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
        say(player, "No Weavers' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      say(player, `Weavers' Guild — ${desc.memberCount} members (${desc.grandcouturiers} grand couturiers), ` +
        `${desc.sealed} certified collections. Atelier inspection: ${desc.inspection}/100. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}.` +
        (m ? ` You are a ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Weavers' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You left the Weavers' Guild." : `Could not leave: ${res.reason}.`);
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
      say(player, "The Weavers' Code: " + Guilds.WEAVERS_CODE.join(" "));
      return;
    }
    case "certify": {
      const collectionId = rest[0];
      if (!collectionId) { say(player, "Usage: ::weaverguild certify <collectionId>"); return; }
      const sub2 = Guilds.submitCollection(username, kingdomId, collectionId, Date.now());
      if (!sub2.ok) { say(player, `Could not submit: ${sub2.reason}.`); return; }
      if (sub2.fee > 0 && !takeCoins(player, sub2.fee)) {
        // The submission is already queued — withdraw it, or the life tick
        // would settle it for free and the fee would be a no-op.
        Guilds.withdrawSubmission(kingdomId, collectionId);
        say(player, `Certification costs ${sub2.fee} coins.`);
        return;
      }
      const res = Guilds.settleCertification(kingdomId, collectionId, Date.now());
      say(player, res.ok
        ? `Collection certified — grade ${res.grade}! Bounty: ${res.paid} coins paid${res.owed ? `, ${res.owed} owed` : ""}.`
        : `Certification failed: ${res.reason}.`);
      return;
    }
    case "seals": {
      const desc = Guilds.describe(kingdomId);
      say(player, `${desc.sealed} collections carry the guild seal in this kingdom.`);
      return;
    }
    case "report": {
      // Report a suspected knockoff: the guild scans the real ledger.
      // The accused is the named designer — never default to the reporter.
      const accused = rest.join(" ");
      if (!accused) { say(player, "Usage: ::weaverguild report <designer>"); return; }
      const res = Guilds.reportKnockoff(kingdomId, accused, username);
      say(player, res.ok ? `Knockoff case opened against ${accused} (case ${res.id}). The tribunal will review the ledgers.`
        : `Could not report: ${res.reason}.`);
      return;
    }
    case "inspect": {
      const res = Guilds.inspectAteliers(kingdomId, Date.now());
      say(player, res.ok
        ? `Atelier inspection: style ${res.inspection}/100 across ${res.inspected} ateliers` +
          (res.idle.length ? `, ${res.idle.length} idle.` : ", all stocked.")
        : "Inspection failed.");
      return;
    }
    case "cases": {
      const s = Guilds.serialize();
      const open = Object.values(s.cases).filter((c) => c.kingdomId === kingdomId && !c.settled);
      say(player, open.length ? open.map((c) => `${c.id}: ${c.accused} (${c.kind})`).join("; ") : "No open knockoff cases.");
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::weaverguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteCase(caseId, username, /^guilty$/i.test(verdict));
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "needle": {
      const desc = Guilds.describe(kingdomId);
      say(player, desc.exists ? `Golden needle prestige: ${desc.prestige}.` : "No guild here yet.");
      return;
    }
    case "contribute": {
      const amount = parseInt(rest[0], 10);
      if (!Number.isFinite(amount) || amount <= 0) { say(player, "Usage: ::weaverguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) { say(player, `You need ${amount} coins.`); return; }
      const g = Guilds.ensureGuild(kingdomId);
      g.treasury += amount;
      say(player, `Contributed ${amount} coins to the guild treasury.`);
      return;
    }
    case "school": {
      const res = Guilds.holdClass(kingdomId, username);
      say(player, res.ok ? `Class held — ${res.taught} apprentices taught.` : `Could not hold class: ${res.reason}.`);
      return;
    }
    case "apprentice": {
      const apprentice = rest.join(" ");
      if (!apprentice) { say(player, "Usage: ::weaverguild apprentice <name>"); return; }
      const res = Guilds.takeApprentice(username, apprentice);
      say(player, res.ok ? `${apprentice} is now your apprentice.` : `Could not mentor: ${res.reason}.`);
      return;
    }
    default:
      say(player, WEAVERGUILD_USAGE);
  }
}

module.exports = { onWeaverGuildCommand, WEAVERGUILD_USAGE , takeCoins };
