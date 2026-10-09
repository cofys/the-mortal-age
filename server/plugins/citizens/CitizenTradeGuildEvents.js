"use strict";

/**
 * CitizenTradeGuildEvents — player-facing merchants' association: the ::tradeguild command.
 *
 * Mirrors the ::bankguild command pattern (PlayerRights.NONE so every player
 * can use it). Players with REAL trader status (merchants-guild member, trader
 * career, stallholder, or caravan trader) can join the merchants' association,
 * pay dues, buy market licenses, certify caravan manifests, enter trade fairs,
 * report trade misconduct, vote on tribunal cases (merchantmasters only), and
 * attend the merchant school. Bots are rejected: citizens act through the
 * brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenTradeGuilds");

const COINS_ID = 995;

const TRADEGUILD_USAGE =
  "::tradeguild [status|join|leave|dues|license|certify|fairs|code|report <name> <unlicensed|gouging>|cases|vote <caseId> <guilty|innocent>|school]";

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
    const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
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

/** Prove REAL trader status from live engine state. All reads defensive. */
function traderProof(player, username) {
  const proof = { guildMember: false, traderCareer: false, stallholder: false, caravanTrader: false };
  try {
    const CG = require("./lib/CitizenGuilds");
    proof.guildMember = CG.guildIdFor(username) === "merchants";
  } catch { /* no guilds */ }
  try {
    const CC = require("./lib/CitizenCareers");
    proof.traderCareer = CC.careerOf(username) === "trader";
  } catch { /* no careers */ }
  try {
    const wares = player?.getAttribute?.("citizens:market-wares");
    proof.stallholder = !!wares;
  } catch { /* no attribute */ }
  try {
    const TC = require("./lib/CitizenTradeCaravans");
    proof.caravanTrader = TC.isCaravanHand(username);
  } catch { /* no caravans */ }
  return proof;
}

function onTradeGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its merchants' association."); return; }
    const d = Guilds.describe(kid);
    if (!d) { say(player, "No merchants' association here yet."); return; }
    say(player, `Merchants' association of ${kid}: ${d.members} members (${d.masters} merchantmasters), treasury ${d.treasury} coins, fair fund ${d.fairFund} coins.`);
    say(player, `${d.licensed} licensed stalls. ${d.openCases} open tribunal cases.`);
    const m = Guilds.memberOf(username);
    if (m) {
      const lic = Guilds.licenseFor(username);
      say(player, `You are a ${m.rank}${m.suspended ? " (suspended)" : ""}.${lic.valid ? " Your market license is valid." : " You hold no valid market license."}`);
    } else {
      say(player, "You are not a member. Real traders can ::tradeguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its merchants' association."); return; }
    const r = Guilds.joinGuild(kid, username, traderProof(player, username));
    if (!r.ok) {
      say(player, r.reason === "not-a-trader"
        ? "Only real traders may join: hold the trader career, belong to the merchants' guild, run a market stall, or trade on a caravan."
        : `Could not join: ${r.reason}.`);
      return;
    }
    say(player, `Welcome to the merchants' association, peddler ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week (${5} feeds the trade-fair fund).`);
    return;
  }

  if (sub === "leave") {
    const r = Guilds.leaveGuild(username);
    say(player, r.ok ? "You have left the merchants' association." : "You were not a member.");
    return;
  }

  if (sub === "dues") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
      say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
      return;
    }
    Guilds.recordDuesPayment(username);
    say(player, "Dues paid. The fair fund thanks you.");
    return;
  }

  if (sub === "license") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "Members only: join the association first."); return; }
    if (!kid) { say(player, "You need to be in a kingdom to buy a license."); return; }
    if (Guilds.licenseFor(username).valid) { say(player, "Your market license is already valid."); return; }
    if (!takeCoins(player, Guilds.LICENSE_FEE)) {
      say(player, `A 30-day market license costs ${Guilds.LICENSE_FEE} coins.`);
      return;
    }
    Guilds.buyLicense(kid, username);
    say(player, "Market license issued for 30 days. Trade honestly.");
    return;
  }

  if (sub === "certify") {
    const m = Guilds.memberOf(username);
    if (!m || m.suspended) { say(player, "Members in good standing only."); return; }
    if (!kid) { say(player, "You need to be in a kingdom to certify."); return; }
    const r = Guilds.certifyManifest(kid, username);
    say(player, r.ok
      ? "Caravan manifest certified for 7 days: +3% profit on caravans you lead."
      : `Could not certify: ${r.reason}.`);
    return;
  }

  if (sub === "fairs") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Guilds.guildOf(kid);
    const fairs = (g?.fairs || []).slice(-3).reverse();
    if (!fairs.length) { say(player, "No trade fairs held yet. The association holds one quarterly."); return; }
    for (const f of fairs) {
      say(player, `${new Date(f.atMs).toLocaleDateString()}: ${f.entries.length} stalls${f.winner ? `, won by ${f.winner} (${f.prizePaid} coins)` : ", no winner"}.`);
    }
    return;
  }

  if (sub === "code") {
    say(player, "The association's standards of honest trade:");
    for (const line of Guilds.STANDARDS_CODE) say(player, line);
    return;
  }

  if (sub === "report") {
    const target = args?.[1];
    const kind = String(args?.[2] || "").toLowerCase();
    if (!target || (kind !== "unlicensed" && kind !== "gouging")) {
      say(player, "Usage: ::tradeguild report <name> <unlicensed|gouging>.");
      return;
    }
    if (!kid) { say(player, "You need to be in a kingdom to report."); return; }
    // Evidence is verified against real records at report time.
    const evidence = {};
    if (kind === "unlicensed") {
      evidence.stallActive = Guilds.inspectionsFor(target).length > 0 || !!Guilds.memberOf(target);
      // A stall is real if we have ever inspected it; the life tick reports
      // live stalls directly. Players report traders they have seen.
      if (!evidence.stallActive) {
        say(player, "The association has no record of that trader's stall. Only report stalls you have seen trading.");
        return;
      }
    }
    const r = Guilds.reportMisconduct(kid, target,
      kind === "unlicensed" ? Guilds.CASE_UNLICENSED : Guilds.CASE_GOUGING,
      username, evidence);
    say(player, r.ok ? `Case opened against ${target}. The merchantmasters will vote.`
      : `Could not open a case: ${r.reason}.`);
    return;
  }

  if (sub === "cases") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const cases = Guilds.openCases(kid);
    if (!cases.length) { say(player, "No open tribunal cases."); return; }
    for (const c of cases.slice(0, 5)) {
      const votes = Object.keys(c.votes || {}).length;
      say(player, `${c.id}: ${c.accused} accused of ${c.kind} (reported by ${c.reporter}, ${votes} votes).`);
    }
    return;
  }

  if (sub === "vote") {
    const caseId = args?.[1];
    const verdict = String(args?.[2] || "").toLowerCase();
    if (!caseId || (verdict !== "guilty" && verdict !== "innocent")) {
      say(player, "Usage: ::tradeguild vote <caseId> <guilty|innocent>.");
      return;
    }
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const r = Guilds.voteOnCase(kid, caseId, username, verdict === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason} (merchantmasters only).`);
    return;
  }

  if (sub === "school") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    const p = Guilds.tryPromote(username);
    if (p.ok) { say(player, `Promoted to ${p.rank} of the merchants' association!`); return; }
    say(player, `Rank: ${m.rank}. Credits: ${m.trainingCredits || 0}. Inspections: ${m.inspectionsConducted || 0}. Attend a merchantmaster's class to earn credits.`);
    return;
  }

  say(player, TRADEGUILD_USAGE);
}

module.exports = { onTradeGuildCommand, TRADEGUILD_USAGE , takeCoins };
