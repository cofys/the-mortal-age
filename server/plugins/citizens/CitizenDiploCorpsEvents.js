"use strict";

/**
 * CitizenDiploCorpsEvents — player-facing diplomatic corps: the ::diploguild command.
 *
 * Mirrors the ::lawguild command pattern (PlayerRights.NONE so every player
 * can use it). Players who are real diplomats (ambassador career or currently
 * serving on a real diplomatic mission) can join the diplomatic corps, pay
 * dues, conduct border reviews (ambassadors only), sponsor mediations
 * (ambassadors only), report treason, vote on treason cases (ambassadors
 * only), view the mediation fund, contribute to it, and attend the
 * diplomatic school. Bots are rejected: citizens act through the brain and
 * the life tick, not the command.
 */

const Corps = require("./lib/CitizenDiplomaticCorps");

const COINS_ID = 995;

const DIPLOCORPS_USAGE =
  "::diploguild [status|join|leave|dues|protocol|reviews|review|mediate <kingdom>|mediations|report <name>|cases|vote <caseId> <guilty|innocent>|contribute <amount>|school]";

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

function onDiploCorpsCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the corps through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its diplomatic corps."); return; }
    const d = Corps.describe(kid);
    if (!d) { say(player, "No diplomatic corps here yet."); return; }
    say(player, `Diplomatic corps of ${kid}: ${d.members} members (${d.ambassadors} ambassadors), treasury ${d.treasury} coins, mediation fund ${d.mediationFund} coins.`);
    say(player, `Frontier: ${d.crisis ? "CRISIS — mediators needed" : "calm"}. ${d.openClaims} open mediation claims, ${d.openCases} open treason cases.`);
    const m = Corps.memberOf(username);
    if (m) {
      say(player, `You are an ${m.rank}${m.suspended ? " (suspended)" : ""}. Dues paid until ${new Date(m.duesPaidUntilMs).toLocaleDateString()}.`);
    } else {
      say(player, "You are not a member. Real diplomats can ::diploguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its diplomatic corps."); return; }
    const r = Corps.joinGuild(kid, username);
    if (!r.ok) {
      say(player, r.reason === "not-a-diplomat"
        ? "Only real diplomats may join the corps — take the ambassador career or serve on a diplomatic mission first."
        : `Could not join: ${r.reason}.`);
      return;
    }
    say(player, `Welcome to the diplomatic corps, envoy ${username}. Dues are ${Corps.DUES_WEEKLY} coins a week (${Corps.DUES_MEDIATION_SHARE} feeds the mediation fund).`);
    return;
  }

  if (sub === "leave") {
    say(player, Corps.leaveGuild(username) ? "You have left the diplomatic corps." : "You were not a member.");
    return;
  }

  if (sub === "dues") {
    const m = Corps.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    if (!takeCoins(player, Corps.DUES_WEEKLY)) {
      say(player, `You need ${Corps.DUES_WEEKLY} coins for dues.`);
      return;
    }
    Corps.recordDuesPayment(username);
    say(player, "Dues paid. The mediation fund stands a little stronger.");
    return;
  }

  if (sub === "protocol") {
    say(player, "Code of diplomatic protocol:");
    for (const line of Corps.protocolCode()) say(player, `- ${line}`);
    return;
  }

  if (sub === "reviews") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Corps.corpsOf(kid);
    if (!g || !g.reviews.length) { say(player, "No border reviews on record."); return; }
    for (const r of g.reviews.slice(-5)) {
      say(player, `${new Date(r.atMs).toLocaleDateString()}: ${r.result}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}`);
    }
    return;
  }

  if (sub === "review") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    if (Corps.guildRankOf(username) !== Corps.RANK_AMBASSADOR) {
      say(player, "Only ambassadors conduct border reviews.");
      return;
    }
    const r = Corps.conductReview(kid, username);
    if (!r.ok) { say(player, `Review failed: ${r.reason}.`); return; }
    say(player, `Review: ${r.result}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}.`);
    return;
  }

  if (sub === "mediate") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    if (Corps.guildRankOf(username) !== Corps.RANK_AMBASSADOR) {
      say(player, "Only ambassadors lead mediations.");
      return;
    }
    const other = args?.[1];
    if (!other) { say(player, "Usage: ::diploguild mediate <kingdom>"); return; }
    const filed = Corps.fileMediationClaim(kid, other);
    if (!filed.ok) {
      say(player, filed.reason === "border-not-hot"
        ? `The ${other} border is not hot enough to need mediation.`
        : filed.reason === "at-war"
          ? `The corps cannot mediate an active war with ${other}.`
          : `Could not file: ${filed.reason}.`);
      return;
    }
    const res = Corps.assignMediation(kid, filed.claimId, username);
    if (!res.ok) { say(player, `Mediation failed: ${res.reason}.`); return; }
    say(player, `Mediation with ${other} complete: border tension cooled from ${Math.round(res.tensionBefore)} to ${Math.round(res.tensionAfter)}. Fee ${res.paid} coins${res.owed ? ` (${res.owed} owed)` : ""}.`);
    return;
  }

  if (sub === "mediations") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Corps.corpsOf(kid);
    if (!g) { say(player, "No diplomatic corps here yet."); return; }
    const claims = Object.entries(g.mediationClaims);
    if (!claims.length) { say(player, "No mediations on record."); return; }
    for (const [cid, c] of claims.slice(-8)) {
      say(player, `${c.otherKingdom}: ${c.status}${c.mediator ? ` by ${c.mediator}` : ""}${c.tensionAfter != null ? ` (tension ${Math.round(c.tensionBefore)}→${Math.round(c.tensionAfter)})` : ""}.`);
    }
    return;
  }

  if (sub === "report") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const accused = args?.[1];
    if (!accused) {
      say(player, "Usage: ::diploguild report <name>");
      return;
    }
    const r = Corps.reportMisconduct(kid, accused, "treason", username);
    say(player, r.ok ? `Treason case opened: ${r.caseId}.` : `Could not open case: ${r.reason}.`);
    return;
  }

  if (sub === "cases") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Corps.corpsOf(kid);
    if (!g) { say(player, "No diplomatic corps here yet."); return; }
    const open = Object.entries(g.cases).filter(([, c]) => c.status === "open");
    if (!open.length) { say(player, "No open treason cases."); return; }
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
      say(player, "Usage: ::diploguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Corps.voteOnCase(kid, caseId, username, how === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason}.`);
    return;
  }

  if (sub === "contribute") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const amount = Math.floor(Number(args?.[1]) || 0);
    if (amount <= 0) { say(player, "Usage: ::diploguild contribute <amount>"); return; }
    if (!takeCoins(player, amount)) { say(player, `You need ${amount} coins.`); return; }
    const r = Corps.contributeMediation(kid, username, amount);
    say(player, r.ok ? `Contributed ${r.contributed} coins to the mediation fund.` : `Contribution failed: ${r.reason}.`);
    return;
  }

  if (sub === "school") {
    const m = Corps.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    say(player, `Diplomatic school: ${m.trainingCredits || 0} training credits. Ambassadors hold protocol classes; envoys study toward negotiator (30 days + 2 credits + 1 mediation).`);
    const r = Corps.tryPromote(username);
    if (r.ok) say(player, `Promoted to ${r.rank}!`);
    return;
  }

  say(player, DIPLOCORPS_USAGE);
}

module.exports = {
  onDiploCorpsCommand,
  DIPLOCORPS_USAGE,
  takeCoins,
};
