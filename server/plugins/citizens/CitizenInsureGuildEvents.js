"use strict";

/**
 * CitizenInsureGuildEvents — player-facing underwriters' association: the ::insureguild command.
 *
 * Mirrors the ::bankguild command pattern (PlayerRights.NONE so every player
 * can use it). Players who are registered insurers can join the underwriters'
 * association, pay dues, conduct solvency reviews (actuaries only), report
 * policy fraud, vote on tribunal cases (actuaries only), view reinsurance,
 * contribute to the fund, and attend the actuarial school. Bots are rejected:
 * citizens act through the brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenInsureGuilds");

const COINS_ID = 995;

const INSUREGUILD_USAGE =
  "::insureguild [status|join|leave|dues|code|reviews|review|report <name>|cases|vote <caseId> <guilty|innocent>|reinsurance|contribute <amount>|school]";

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

function onInsureGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its underwriters' association."); return; }
    const d = Guilds.describe(kid);
    if (!d) { say(player, "No underwriters' association here yet."); return; }
    say(player, `Underwriters' association of ${kid}: ${d.members} members (${d.actuaries} actuaries), treasury ${d.treasury} coins, reinsurance fund ${d.reinsuranceFund} coins.`);
    say(player, `Pool status: ${d.poolStatus}${d.lastVerdict ? ` (last review: ${d.lastVerdict})` : ""}. ${d.openClaims} open reinsurance claims.`);
    const m = Guilds.memberOf(username);
    if (m) {
      say(player, `You are an ${m.rank}${m.suspended ? " (suspended)" : ""}. Dues paid until ${new Date(m.duesPaidUntil).toLocaleDateString()}.`);
    } else {
      say(player, "You are not a member. Registered insurers can ::insureguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its underwriters' association."); return; }
    const r = Guilds.joinGuild(username, kid);
    if (!r.ok) {
      say(player, r.reason === "not-insurer"
        ? "Only registered insurers may join the underwriters' association. Sell a policy first."
        : `Could not join: ${r.reason}.`);
      return;
    }
    say(player, `Welcome to the underwriters' association, agent ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week (${Guilds.DUES_REINSURANCE_SHARE} feeds the reinsurance fund).`);
    return;
  }

  if (sub === "leave") {
    say(player, Guilds.leaveGuild(username) ? "You have left the underwriters' association." : "You were not a member.");
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
    say(player, "Dues paid. The reinsurance fund stands a little stronger.");
    return;
  }

  if (sub === "code") {
    say(player, "The guild's standards of underwriting practice:");
    for (const line of Guilds.STANDARDS_CODE) say(player, line);
    return;
  }

  if (sub === "reviews") {
    if (!kid) { say(player, "You need to be in a kingdom to see its reviews."); return; }
    const reviews = Guilds.reviewsFor(kid).slice(0, 5);
    if (!reviews.length) { say(player, "No reviews yet. The guild inspects the pool's solvency weekly."); return; }
    for (const r of reviews) {
      say(player, `${new Date(r.conductedAt).toLocaleDateString()}: ${r.verdict.toUpperCase()} by ${r.reviewer} — coverage ${r.coverage < 0 ? "infinite" : r.coverage.toFixed(2)}, ${r.unpaidClaims} unpaid claim(s), ${r.insurerCount} insurer(s)${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}.`);
    }
    return;
  }

  if (sub === "review") {
    if (!kid) { say(player, "You need to be in a kingdom to review its pool."); return; }
    const r = Guilds.conductReview(kid, username);
    if (!r.ok) {
      say(player, r.reason === "not-an-actuary"
        ? "Only actuary-rank guild members may conduct solvency reviews."
        : `Could not review: ${r.reason}.`);
      return;
    }
    const rev = r.review;
    say(player, `Review ${rev.verdict.toUpperCase()}: coverage ${rev.coverage < 0 ? "infinite" : rev.coverage.toFixed(2)}, ${rev.unpaidClaims} unpaid claim(s), ${rev.insurerCount} insurer(s).${rev.reasons.length ? ` Findings: ${rev.reasons.join("; ")}.` : ""} Pool is now ${r.poolStatus}.`);
    return;
  }

  if (sub === "report") {
    const accused = String(args?.[1] || "").trim();
    if (!accused) {
      say(player, "Usage: ::insureguild report <name>  (policy fraud — impossible face values)");
      return;
    }
    const r = Guilds.reportFraud(username, accused);
    if (!r.ok) { say(player, `Could not file: ${r.reason}.`); return; }
    say(player, `Ethics case ${r.caseId} opened against ${accused} (policy fraud). The tribunal of actuaries will rule.`);
    return;
  }

  if (sub === "cases") {
    const open = Guilds.openCases(kid);
    if (!open.length) { say(player, "No open ethics cases."); return; }
    for (const c of open.slice(0, 8)) {
      say(player, `${c.id}: ${c.accused} accused of ${c.type} — filed ${new Date(c.filedAt).toLocaleDateString()}, ${Object.keys(c.votes).length} actuary votes.`);
    }
    return;
  }

  if (sub === "vote") {
    const caseId = String(args?.[1] || "").trim();
    const how = String(args?.[2] || "").toLowerCase();
    if (!caseId || !["guilty", "innocent"].includes(how)) {
      say(player, "Usage: ::insureguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Guilds.voteOnCase(username, caseId, how === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason} (actuaries in good standing only).`);
    return;
  }

  if (sub === "reinsurance") {
    if (!kid) { say(player, "You need to be in a kingdom to see its reinsurance fund."); return; }
    say(player, `Reinsurance: the fund holds ${Guilds.reinsuranceFundOf(kid)} coins, backing the insurer pool when it cannot pay.`);
    const claims = Guilds.openReinsuranceClaims(kid).filter((c) => c.claimant === username.toLowerCase());
    if (claims.length) say(player, `You have ${claims.length} open reinsurance claim(s), ${claims.reduce((n, c) => n + (c.owed || 0), 0)} coins owed.`);
    else say(player, "Reinsurance claims are filed automatically when the pool goes insolvent.");
    return;
  }

  if (sub === "contribute") {
    if (!kid) { say(player, "You need to be in a kingdom to contribute to its reinsurance fund."); return; }
    const amount = Math.floor(Number(args?.[1]) || 0);
    if (amount <= 0) { say(player, "Usage: ::insureguild contribute <amount>"); return; }
    if (!takeCoins(player, amount)) { say(player, `You need ${amount} coins to contribute.`); return; }
    const r = Guilds.contributeToFund(kid, amount);
    say(player, r.ok ? `Contributed ${amount} coins. The reinsurance fund now holds ${r.fund} coins.` : `Could not contribute: ${r.reason}.`);
    return;
  }

  if (sub === "school") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    const p = Guilds.tryPromote(username);
    if (p.ok) { say(player, `Promoted to ${p.rank} of the underwriters' association!`); return; }
    const tenureDays = Math.floor((Date.now() - (m.joinedAt || Date.now())) / (24 * 60 * 60 * 1000));
    say(player, `Rank: ${m.rank}. Tenure: ${tenureDays} days. Training credits: ${m.trainingCredits || 0}. Reviews conducted: ${m.reviewsConducted || 0}.`);
    if (p.reason === "tenure") say(player, "You need more tenure — keep paying dues and showing up.");
    if (p.reason === "training") say(player, "You need more training credits — attend an actuary's class.");
    if (p.reason === "reviews") say(player, "You need to conduct more solvency reviews.");
    if (p.reason === "ethics-record") say(player, "Your ethics record must be clean.");
    if (p.reason === "max-rank") say(player, "You are already an actuary.");
    if (p.reason === "not-eligible") say(player, "You are not eligible for promotion right now.");
    return;
  }

  say(player, INSUREGUILD_USAGE);
}

module.exports = { onInsureGuildCommand, INSUREGUILD_USAGE , takeCoins };
