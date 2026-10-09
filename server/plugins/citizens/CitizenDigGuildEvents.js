"use strict";

/**
 * CitizenDigGuildEvents — player-facing Excavators' Guild: the ::digguild command.
 *
 * Mirrors the ::dig / ::mapguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit owned
 * artifacts for guild authentication, report suspected forgeries, vote on
 * tribunal cases, inspect dig sites, contribute to the conservation fund,
 * and arrange mentorship. Bots are rejected: citizens act through the
 * brain and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenDigGuilds");

const COINS_ID = 995;

const DIGGUILD_USAGE =
  "::digguild [status|join|leave|dues|code|authenticate <artifactId>|seals|report <artifactId>|cases|vote <caseId> <guilty|innocent>|inspect <siteId>|contribute <coins>|school|apprentice <name>]";

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

function onDigGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "The guild needs a kingdom to describe."); return; }
    const d = Guilds.describe(kid);
    if (!d.exists) { say(player, "No Excavators' Guild stands here yet."); return; }
    const rank = Guilds.guildRankOf(username);
    say(player, `Excavators' Guild — treasury ${d.treasury}c, conservation fund ${d.conservationFund}c, prestige ${d.prestige}.`);
    say(player, `${d.memberCount} members (${d.conservators} conservators), ${d.authenticated} sealed artifacts, ${d.protected} protected sites, ${d.openCases} open cases.`);
    if (rank) say(player, `You are a ${rank} in good standing.`);
    else say(player, "You are not a member. Registered archaeologists may ::digguild join.");
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "The guild needs a kingdom to place you in."); return; }
    const r = Guilds.joinGuild(username, kid);
    if (!r.ok) { say(player, `The guild refuses: ${r.reason}.`); return; }
    say(player, r.already ? `Welcome back, ${r.rank}.` : "Welcome to the Excavators' Guild, digger. A week's dues are on the house.");
    return;
  }

  if (sub === "leave") {
    const r = Guilds.leaveGuild(username);
    say(player, r.ok ? "You left the Excavators' Guild." : `Leave failed: ${r.reason}.`);
    return;
  }

  if (sub === "dues") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    if ((m.duesPaidUntilMs || 0) > Date.now()) { say(player, "Your dues are paid up."); return; }
    if (!takeCoins(player, Guilds.DUES_WEEKLY)) { say(player, `You need ${Guilds.DUES_WEEKLY} coins for a week's dues.`); return; }
    Guilds.recordDuesPayment(username, Date.now());
    say(player, "Dues paid. The guild hall doors stay open to you.");
    return;
  }

  if (sub === "code") {
    say(player, "The Excavator's Code:");
    for (const line of Guilds.EXCAVATION_CODE) say(player, `- ${line}`);
    return;
  }

  if (sub === "authenticate") {
    const artifactId = args?.[1];
    if (!artifactId) { say(player, "Usage: ::digguild authenticate <artifactId>"); return; }
    const res = Guilds.authenticateArtifact(
      username, artifactId,
      (who, coins) => takeCoins(player, coins),
      (who, coins) => giveCoins(player, coins));
    if (!res.ok) { say(player, `Authentication failed: ${res.reason}.`); return; }
    say(player, `Sealed: grade ${res.grade}${res.protected ? " (protected-site find, double bounty)" : ""}. Bounty ${res.bounty}c${res.owed > 0 ? ` — ${res.owed}c owed when the treasury refills` : ", paid"}.`);
    return;
  }

  if (sub === "seals") {
    if (!kid) { say(player, "The guild needs a kingdom to describe."); return; }
    const d = Guilds.describe(kid);
    say(player, `${d.authenticated} artifacts carry the guild seal in this kingdom's archive.`);
    return;
  }

  if (sub === "report") {
    const artifactId = args?.[1];
    if (!artifactId) { say(player, "Usage: ::digguild report <artifactId>"); return; }
    if (!kid) { say(player, "The guild needs a kingdom to file in."); return; }
    const r = Guilds.reportForgery(kid, artifactId, username);
    if (!r.ok) { say(player, `Report rejected: ${r.reason}.`); return; }
    say(player, `Forgery case opened (${r.id}): ${r.kind}. Conservators will vote.`);
    return;
  }

  if (sub === "cases") {
    if (!kid) { say(player, "The guild needs a kingdom to describe."); return; }
    const d = Guilds.describe(kid);
    say(player, `${d.openCases} forgery cases open in this kingdom.`);
    return;
  }

  if (sub === "vote") {
    const caseId = args?.[1];
    const verdict = String(args?.[2] || "").toLowerCase();
    if (!caseId || (verdict !== "guilty" && verdict !== "innocent")) {
      say(player, "Usage: ::digguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Guilds.voteOnCase(caseId, username, verdict === "guilty");
    say(player, r.ok ? "Vote recorded." : `Vote rejected: ${r.reason}.`);
    return;
  }

  if (sub === "inspect") {
    const siteId = args?.[1];
    if (!siteId) { say(player, "Usage: ::digguild inspect <siteId>"); return; }
    const r = Guilds.inspectSite(siteId);
    if (!r.ok) { say(player, `Inspection failed: ${r.reason}.`); return; }
    say(player, `Inspection of ${r.site.name}: ${r.result}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}${r.protected ? " (PROTECTED)" : ""}.`);
    return;
  }

  if (sub === "contribute") {
    const coins = Math.floor(Number(args?.[1] || 0));
    if (!coins || coins <= 0) { say(player, "Usage: ::digguild contribute <coins>"); return; }
    if (!takeCoins(player, coins)) { say(player, "You don't have those coins."); return; }
    const r = Guilds.contribute(username, coins, () => true);
    say(player, r.ok ? `The conservation fund thanks you (${r.fund}c).` : `Contribution failed: ${r.reason}.`);
    return;
  }

  if (sub === "school") {
    const el = Guilds.canPromote(username);
    if (el.ok) {
      const p = Guilds.promote(username);
      say(player, p.ok ? `Promoted to ${p.rank}.` : `Promotion failed: ${p.reason}.`);
    } else {
      say(player, `Not yet promotable: ${el.reason}. Attend field school and keep digging.`);
    }
    return;
  }

  if (sub === "apprentice") {
    const name = args?.slice(1).join(" ");
    if (!name) { say(player, "Usage: ::digguild apprentice <name>"); return; }
    const r = Guilds.takeApprentice(username, name);
    say(player, r.ok ? `${name} is now under your wing — no fees, double credit.` : `Mentorship failed: ${r.reason}.`);
    return;
  }

  say(player, DIGGUILD_USAGE);
}

module.exports = { onDigGuildCommand, DIGGUILD_USAGE , giveCoins, takeCoins };
