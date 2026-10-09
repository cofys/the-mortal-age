"use strict";

/**
 * CitizenPressGuildEvents — player-facing press association: the ::pressguild command.
 *
 * Mirrors the ::mapguild command pattern (PlayerRights.NONE so every player
 * can use it). Players who are registered journalists can join the press
 * association, pay dues, report ethics violations, vote on tribunal cases
 * (editors only), view Inkwell awards, attend the journalism school, and
 * buy press passes. Bots are rejected: citizens act through the brain and
 * the life tick, not the command.
 */

const Guilds = require("./lib/CitizenPressGuilds");

const COINS_ID = 995;

const PRESSGUILD_USAGE =
  "::pressguild [status|join|leave|dues|code|report <name> <fabrication|plagiarism> <storyId>|cases|vote <caseId> <guilty|innocent>|awards|school|pass|daypass]";

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
    const has = inv.getAmount?.(COINS_ID) ?? 0;
    if (has < amount) return false;
    // Canonical: deleteNumber(id, amount) / delete(id, amount). ItemContainer
    // has no remove(id, amount).
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    else return false;
    // Honest: the balance must actually have moved, or the fee wasn't taken.
    return (inv.getAmount?.(COINS_ID) ?? 0) === has - amount;
  } catch {
    return false;
  }
}

const ETHICS_CODE = [
  "1. Truth: never invent an event — every story traces to a real happening.",
  "2. Attribution: never republish another reporter's story as your own.",
  "3. Sources: protect informants; correct the record when wrong.",
  "4. Independence: no bribes for coverage; the treasury is the guild's, not a patron's.",
  "5. Accountability: submit to the tribunal's verdict like any member.",
];

function onPressGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its press association."); return; }
    const d = Guilds.describe(kid);
    if (!d) { say(player, "No press association here yet."); return; }
    say(player, `Press association of ${kid}: ${d.members} members (${d.editors} editors), treasury ${d.treasury} coins, ${d.openCases} open ethics cases, ${d.awards} Inkwells awarded.`);
    const m = Guilds.memberOf(username);
    if (m) {
      say(player, `You are a ${m.rank}${m.suspended ? " (suspended)" : ""}. Dues paid until ${new Date(m.duesPaidUntil).toLocaleDateString()}.`);
      if (m.fineOwed > 0) say(player, `You owe the tribunal ${m.fineOwed} coins in fines.`);
      if (Guilds.hasPressPass(username)) say(player, "Your press pass is valid.");
    } else {
      say(player, "You are not a member. Registered journalists can ::pressguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its press association."); return; }
    const r = Guilds.joinGuild(username, kid);
    if (!r.ok) {
      say(player, r.reason === "not-journalist"
        ? "Only registered journalists may join the press association. File stories first."
        : `Could not join: ${r.reason}.`);
      return;
    }
    Guilds.issueMemberPass(username);
    say(player, `Welcome to the press association, stringer ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week. Your press pass is valid for ${Guilds.PASS_MEMBER_DAYS} days.`);
    return;
  }

  if (sub === "leave") {
    say(player, Guilds.leaveGuild(username) ? "You have left the press association." : "You were not a member.");
    return;
  }

  if (sub === "dues") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    let paidFine = 0;
    if (m.fineOwed > 0) {
      const fine = Math.min(m.fineOwed, Guilds.PLAGIARISM_FINE * 10);
      if (takeCoins(player, fine)) {
        m.fineOwed -= fine;
        paidFine = fine;
        Guilds.creditTreasury(m.kingdomId, fine);
      }
    }
    if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
      say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues${m.fineOwed > 0 ? ` (and you still owe ${m.fineOwed} in fines)` : ""}.`);
      return;
    }
    m.duesPaidUntil = Date.now() + Guilds.DUES_PERIOD_MS;
    m.missedDues = 0;
    if (m.suspended && m.suspendUntil <= Date.now()) { m.suspended = false; m.suspendUntil = 0; }
    Guilds.creditTreasury(m.kingdomId, Guilds.DUES_WEEKLY);
    say(player, `Dues paid.${paidFine > 0 ? ` Fine reduced by ${paidFine} coins.` : ""}${!m.suspended ? " Suspension lifted." : ""}`);
    return;
  }

  if (sub === "code") {
    say(player, "The press code of ethics:");
    for (const line of ETHICS_CODE) say(player, line);
    return;
  }

  if (sub === "report") {
    const accused = String(args?.[1] || "").trim();
    const type = String(args?.[2] || "").toLowerCase();
    const storyId = String(args?.[3] || "").trim();
    if (!accused || !Guilds.VIOLATION_TYPES.includes(type) || !storyId) {
      say(player, "Usage: ::pressguild report <name> <fabrication|plagiarism> <storyId>");
      return;
    }
    const r = Guilds.reportViolation(username, accused, type, storyId);
    if (!r.ok) { say(player, `Could not file: ${r.reason}.`); return; }
    say(player, `Ethics case ${r.id} opened against ${accused} (${type}). The tribunal of editors will rule.`);
    return;
  }

  if (sub === "cases") {
    const open = Guilds.openCases(kid);
    if (!open.length) { say(player, "No open ethics cases."); return; }
    for (const c of open.slice(0, 8)) {
      say(player, `${c.id}: ${c.accused} accused of ${c.type} (story ${c.storyId}) — filed ${new Date(c.filedAt).toLocaleDateString()}, ${Object.keys(c.votes).length} editor votes.`);
    }
    return;
  }

  if (sub === "vote") {
    const caseId = String(args?.[1] || "").trim();
    const how = String(args?.[2] || "").toLowerCase();
    if (!caseId || !["guilty", "innocent"].includes(how)) {
      say(player, "Usage: ::pressguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Guilds.voteOnCase(caseId, username, how === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason} (editors in good standing only).`);
    return;
  }

  if (sub === "awards") {
    if (!kid) { say(player, "You need to be in a kingdom to see its Inkwells."); return; }
    const awards = Guilds.awardsFor(kid).slice(0, 8);
    if (!awards.length) { say(player, "No Inkwell awards yet. Publish great stories and the guild will notice."); return; }
    for (const a of awards) {
      say(player, `${a.beat}: ${a.winner} (quality ${a.quality}, ${a.prize} coins${a.prizeOwed > 0 ? ", prize owed" : ""}) — ${new Date(a.awardedAt).toLocaleDateString()}.`);
    }
    return;
  }

  if (sub === "school") {
    const elig = Guilds.promotionEligible(username);
    if (elig.ok) {
      const p = Guilds.promote(username);
      say(player, p.ok ? `Promoted to ${p.to} of the press guild!` : "Promotion failed.");
      return;
    }
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    say(player, `Rank: ${m.rank}. Training credits: ${m.trainingCredits || 0}. Stories filed: ${Guilds.storyCountFor(username)}. ${elig.reason === "needs-stories" ? `Need ${elig.need} more stories.` : ""}${elig.reason === "needs-training" ? `Need ${elig.need} more training credits — attend an editor's class.` : ""}${elig.reason === "ethics-record" ? "Your ethics record must be clean." : ""}${elig.reason === "at-top" ? "You are already an editor." : ""}`);
    return;
  }

  if (sub === "pass") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "Only members carry press passes. Day visitors: ::pressguild daypass."); return; }
    if (m.suspended) { say(player, "Suspended members cannot renew passes."); return; }
    const r = Guilds.issueMemberPass(username);
    say(player, r.ok ? `Press pass renewed — valid until ${new Date(r.expiresAt).toLocaleDateString()}.` : "Could not issue a pass.");
    return;
  }

  if (sub === "daypass") {
    if (!kid) { say(player, "You need to be in a kingdom for a day pass."); return; }
    if (!takeCoins(player, Guilds.PASS_PLAYER_FEE)) {
      say(player, `A day pass costs ${Guilds.PASS_PLAYER_FEE} coins.`);
      return;
    }
    Guilds.creditTreasury(kid, Guilds.PASS_PLAYER_FEE);
    const r = Guilds.issueDayPass(username, kid);
    say(player, r.ok ? `Day press pass issued — valid until ${new Date(r.expiresAt).toLocaleDateString()}.` : "Could not issue a pass.");
    return;
  }

  say(player, PRESSGUILD_USAGE);
}

module.exports = { onPressGuildCommand, PRESSGUILD_USAGE , takeCoins };
