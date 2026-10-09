"use strict";

/**
 * CitizenBankGuildEvents — player-facing bankers' association: the ::bankguild command.
 *
 * Mirrors the ::pressguild command pattern (PlayerRights.NONE so every player
 * can use it). Players who are registered bankers can join the bankers'
 * association, pay dues, conduct branch audits (auditors only), report
 * ledger tampering, vote on tribunal cases (auditors only), view deposit
 * insurance, file claims, and attend the banker school. Bots are rejected:
 * citizens act through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenBankGuilds");

const COINS_ID = 995;

const BANKGUILD_USAGE =
  "::bankguild [status|join|leave|dues|code|audits|audit|report <name>|cases|vote <caseId> <guilty|innocent>|insurance|claim|school]";

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

function onBankGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its bankers' association."); return; }
    const d = Guilds.describe(kid);
    if (!d) { say(player, "No bankers' association here yet."); return; }
    say(player, `Bankers' association of ${kid}: ${d.members} members (${d.auditors} auditors), treasury ${d.treasury} coins, insurance fund ${d.insuranceFund} coins.`);
    say(player, `Branch status: ${d.branchStatus}${d.branchFlags > 0 ? ` (${d.branchFlags} consecutive flags)` : ""}${d.certifiedUntil > Date.now() ? " — guild-certified" : ""}. ${d.openClaims} open insurance claims.`);
    const m = Guilds.memberOf(username);
    if (m) {
      say(player, `You are a ${m.rank}${m.suspended ? " (suspended)" : ""}. Dues paid until ${new Date(m.duesPaidUntil).toLocaleDateString()}.`);
      if (Guilds.isCovered(username)) say(player, "Your deposits are insured.");
    } else {
      say(player, "You are not a member. Registered bankers can ::bankguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its bankers' association."); return; }
    const r = Guilds.joinGuild(username, kid);
    if (!r.ok) {
      say(player, r.reason === "not-banker"
        ? "Only registered bankers may join the bankers' association. Serve at a branch first."
        : `Could not join: ${r.reason}.`);
      return;
    }
    say(player, `Welcome to the bankers' association, clerk ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week (${Guilds.DUES_INSURANCE_SHARE} feeds the deposit insurance fund).`);
    return;
  }

  if (sub === "leave") {
    say(player, Guilds.leaveGuild(username) ? "You have left the bankers' association." : "You were not a member.");
    return;
  }

  if (sub === "dues") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
      say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
      return;
    }
    m.duesPaidUntil = Date.now() + Guilds.DUES_PERIOD_MS;
    m.missedDues = 0;
    if (m.suspended && m.suspendUntil <= Date.now()) { m.suspended = false; m.suspendUntil = 0; }
    Guilds.creditTreasury(m.kingdomId, Guilds.DUES_WEEKLY - Guilds.DUES_INSURANCE_SHARE);
    Guilds.creditInsuranceFund(m.kingdomId, Guilds.DUES_INSURANCE_SHARE);
    say(player, `Dues paid.${!m.suspended ? " Suspension lifted." : ""}`);
    return;
  }

  if (sub === "code") {
    say(player, "The guild's standards of banking practice:");
    for (const line of Guilds.STANDARDS_CODE) say(player, line);
    return;
  }

  if (sub === "audits") {
    if (!kid) { say(player, "You need to be in a kingdom to see its audits."); return; }
    const audits = Guilds.auditsFor(kid).slice(0, 5);
    if (!audits.length) { say(player, "No audits yet. The guild inspects every branch weekly."); return; }
    for (const a of audits) {
      say(player, `${new Date(a.conductedAt).toLocaleDateString()}: ${a.verdict.toUpperCase()} by ${a.auditor} — leverage ${a.leverage < 0 ? "infinite" : a.leverage.toFixed(2)}, defaults ${(a.defaultRate * 100).toFixed(1)}%${a.reasons.length ? ` (${a.reasons.join("; ")})` : ""}.`);
    }
    return;
  }

  if (sub === "audit") {
    if (!kid) { say(player, "You need to be in a kingdom to audit its branch."); return; }
    const r = Guilds.conductAudit(kid, username);
    if (!r.ok) {
      say(player, r.reason === "not-an-auditor"
        ? "Only auditor-rank guild members may conduct audits."
        : `Could not audit: ${r.reason}.`);
      return;
    }
    const a = r.audit;
    say(player, `Audit ${a.verdict.toUpperCase()}: leverage ${a.leverage < 0 ? "infinite" : a.leverage.toFixed(2)}, default rate ${(a.defaultRate * 100).toFixed(1)}%, ${a.bankerCount} banker(s).${a.reasons.length ? ` Findings: ${a.reasons.join("; ")}.` : ""} Branch is now ${r.branchStatus}.`);
    return;
  }

  if (sub === "report") {
    const accused = String(args?.[1] || "").trim();
    if (!accused) {
      say(player, "Usage: ::bankguild report <name>  (ledger tampering — negative balances)");
      return;
    }
    const r = Guilds.reportViolation(username, accused, Guilds.VIOLATION_TAMPERING);
    if (!r.ok) { say(player, `Could not file: ${r.reason}.`); return; }
    say(player, `Ethics case ${r.id} opened against ${accused} (ledger tampering). The tribunal of auditors will rule.`);
    return;
  }

  if (sub === "cases") {
    const open = Guilds.openCases(kid);
    if (!open.length) { say(player, "No open ethics cases."); return; }
    for (const c of open.slice(0, 8)) {
      say(player, `${c.id}: ${c.accused} accused of ${c.type} — filed ${new Date(c.filedAt).toLocaleDateString()}, ${Object.keys(c.votes).length} auditor votes.`);
    }
    return;
  }

  if (sub === "vote") {
    const caseId = String(args?.[1] || "").trim();
    const how = String(args?.[2] || "").toLowerCase();
    if (!caseId || !["guilty", "innocent"].includes(how)) {
      say(player, "Usage: ::bankguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Guilds.voteOnCase(caseId, username, how === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason} (auditors in good standing only).`);
    return;
  }

  if (sub === "insurance") {
    if (!kid) { say(player, "You need to be in a kingdom to see its insurance fund."); return; }
    say(player, `Deposit insurance: fund holds ${Guilds.insuranceFundFor(kid)} coins. Coverage up to ${Guilds.INSURANCE_COVERAGE_CAP} coins per depositor.`);
    const covered = Guilds.isCovered(username);
    say(player, covered
      ? "Your deposits are insured."
      : `Your deposits are NOT insured. Premium is 1% of balance (max ${Guilds.INSURANCE_PREMIUM_CAP} coins) per month — keep coins in your inventory and stay online to be collected.`);
    const claims = Guilds.openClaims(kid).filter((c) => c.depositor === username.toLowerCase());
    if (claims.length) say(player, `You have ${claims.length} open claim(s), ${claims.reduce((n, c) => n + (c.owed || 0), 0)} coins owed.`);
    return;
  }

  if (sub === "claim") {
    if (!kid) { say(player, "You need to be in a kingdom to check claims."); return; }
    const mine = Guilds.openClaims(kid).filter((c) => c.depositor === username.toLowerCase());
    if (!mine.length) { say(player, "You have no open insurance claims. Claims are filed automatically when a branch fails."); return; }
    for (const c of mine) {
      say(player, `Claim ${c.id}: ${c.paid}/${c.amount} coins paid, ${c.owed} owed. The fund pays as dues refill it.`);
    }
    return;
  }

  if (sub === "school") {
    const elig = Guilds.promotionEligible(username);
    if (elig.ok) {
      const p = Guilds.promote(username);
      say(player, p.ok ? `Promoted to ${p.to} of the bankers' guild!` : "Promotion failed.");
      return;
    }
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    const days = Guilds.tenureDays(m);
    say(player, `Rank: ${m.rank}. Tenure: ${days} days. Training credits: ${m.trainingCredits || 0}. Audits conducted: ${m.auditsConducted || 0}.`);
    if (elig.reason === "needs-tenure") say(player, `Need ${elig.need} more days of tenure.`);
    if (elig.reason === "needs-training") say(player, `Need ${elig.need} more training credits — attend an auditor's class.`);
    if (elig.reason === "needs-audits") say(player, `Need ${elig.need} more conducted audits.`);
    if (elig.reason === "ethics-record") say(player, "Your ethics record must be clean.");
    if (elig.reason === "at-top") say(player, "You are already an auditor.");
    return;
  }

  say(player, BANKGUILD_USAGE);
}

module.exports = { onBankGuildCommand, BANKGUILD_USAGE , takeCoins };
