"use strict";

/**
 * CitizenLawGuildEvents — player-facing bar association: the ::lawguild command.
 *
 * Mirrors the ::insureguild command pattern (PlayerRights.NONE so every player
 * can use it). Players who are real lawyers (lawyer career or hired-advocate
 * history) can join the bar association, pay dues, conduct case reviews
 * (counselors only), report misconduct, vote on disciplinary cases (counselors
 * only), view the pro bono fund, contribute to it, and attend the legal
 * school. Bots are rejected: citizens act through the brain and the life
 * tick, not the command.
 */

const Guilds = require("./lib/CitizenLawGuilds");

const COINS_ID = 995;

const LAWGUILD_USAGE =
  "::lawguild [status|join|leave|dues|code|reviews|review|report <name> <fee-fraud|oathbreaking> [disputeId]|cases|vote <caseId> <guilty|innocent>|probono|contribute <amount>|school]";

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

function onLawGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its bar association."); return; }
    const d = Guilds.describe(kid);
    if (!d) { say(player, "No bar association here yet."); return; }
    say(player, `Bar association of ${kid}: ${d.members} members (${d.counselors} counselors), treasury ${d.treasury} coins, pro bono fund ${d.probonoFund} coins.`);
    say(player, `Docket: ${d.backlogged ? "BACKLOGGED — pro bono advocates needed" : "current"}. ${d.openClaims} open pro bono claims, ${d.openCases} open disciplinary cases.`);
    const m = Guilds.memberOf(username);
    if (m) {
      say(player, `You are a ${m.rank}${m.suspended ? " (suspended)" : ""}. Dues paid until ${new Date(m.duesPaidUntilMs).toLocaleDateString()}.`);
    } else {
      say(player, "You are not a member. Real lawyers can ::lawguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its bar association."); return; }
    const r = Guilds.joinGuild(kid, username);
    if (!r.ok) {
      say(player, r.reason === "not-a-lawyer"
        ? "Only real lawyers may join the bar association — take the lawyer career or serve as a hired advocate first."
        : `Could not join: ${r.reason}.`);
      return;
    }
    say(player, `Welcome to the bar association, clerk ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week (${Guilds.DUES_PROBONO_SHARE} feeds the pro bono fund).`);
    return;
  }

  if (sub === "leave") {
    say(player, Guilds.leaveGuild(username) ? "You have left the bar association." : "You were not a member.");
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
    say(player, "Dues paid. The pro bono fund stands a little stronger.");
    return;
  }

  if (sub === "code") {
    say(player, "Code of legal practice:");
    for (const line of Guilds.codeOfPractice()) say(player, `- ${line}`);
    return;
  }

  if (sub === "reviews") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Guilds.guildOf(kid);
    if (!g || !g.reviews.length) { say(player, "No case reviews on record."); return; }
    for (const r of g.reviews.slice(-5)) {
      say(player, `${new Date(r.atMs).toLocaleDateString()}: ${r.result}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}`);
    }
    return;
  }

  if (sub === "review") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    if (Guilds.guildRankOf(username) !== Guilds.RANK_COUNSELOR) {
      say(player, "Only counselors conduct case reviews.");
      return;
    }
    const r = Guilds.conductReview(kid, username);
    if (!r.ok) { say(player, `Review failed: ${r.reason}.`); return; }
    say(player, `Review: ${r.result}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}.`);
    return;
  }

  if (sub === "report") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const accused = args?.[1];
    const kind = String(args?.[2] || "").toLowerCase().replace(/_/g, "-");
    const disputeId = args?.[3] || null;
    if (!accused || !["fee-fraud", "oathbreaking"].includes(kind)) {
      say(player, "Usage: ::lawguild report <name> <fee-fraud|oathbreaking> [disputeId]");
      return;
    }
    const r = Guilds.reportMisconduct(kid, accused, kind, disputeId, username);
    say(player, r.ok ? `Disciplinary case opened: ${r.caseId}.` : `Could not open case: ${r.reason}.`);
    return;
  }

  if (sub === "cases") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Guilds.guildOf(kid);
    if (!g) { say(player, "No bar association here yet."); return; }
    const open = Object.entries(g.cases).filter(([, c]) => c.status === "open");
    if (!open.length) { say(player, "No open disciplinary cases."); return; }
    for (const [cid, c] of open) {
      say(player, `${cid}: ${c.accused} accused of ${c.kind} (reported by ${c.reporter}).`);
    }
    return;
  }

  if (sub === "vote") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const caseId = args?.[1];
    const how = String(args?.[2] || "").toLowerCase();
    if (!caseId || !["guilty", "innocent", "not"].includes(how)) {
      say(player, "Usage: ::lawguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Guilds.voteOnCase(kid, caseId, username, how === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason}.`);
    return;
  }

  if (sub === "probono") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Guilds.guildOf(kid);
    if (!g) { say(player, "No bar association here yet."); return; }
    const open = Object.values(g.probonoClaims).filter((c) => c.status === "open" || c.status === "owed");
    say(player, `Pro bono fund: ${g.probonoFund} coins. ${open.length} claim(s) awaiting advocates.`);
    return;
  }

  if (sub === "contribute") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const amount = Math.floor(Number(args?.[1]) || 0);
    if (amount <= 0) { say(player, "Usage: ::lawguild contribute <amount>"); return; }
    if (!takeCoins(player, amount)) { say(player, `You need ${amount} coins.`); return; }
    const r = Guilds.contributeProBono(kid, username, amount);
    say(player, r.ok ? `Contributed ${r.contributed} coins to the pro bono fund.` : `Contribution failed: ${r.reason}.`);
    return;
  }

  if (sub === "school") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    say(player, `Legal school: ${m.trainingCredits || 0} training credits. Counselors hold classes; clerks study toward advocate (${Guilds.RANK_ADVOCATE} at 30 days + 2 credits + 1 case).`);
    const r = Guilds.tryPromote(username);
    if (r.ok) say(player, `Promoted to ${r.rank}!`);
    return;
  }

  say(player, LAWGUILD_USAGE);
}

module.exports = {
  onLawGuildCommand,
  LAWGUILD_USAGE,
  takeCoins,
};
