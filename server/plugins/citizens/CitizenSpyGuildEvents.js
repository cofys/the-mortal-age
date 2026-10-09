"use strict";

/**
 * CitizenSpyGuildEvents — player-facing shadow guild: the ::spyguild command.
 *
 * Mirrors the ::diploguild command pattern (PlayerRights.NONE so every
 * player can use it). Players who are real spies (spymaster career, a real
 * network spy/handler, a live cell operative, or an appointed
 * counter-agent) can join the shadow guild, pay dues, leave dead drops,
 * pick up sealed messages, lay low at the safe house, run guild
 * interrogations (spymasters only), report moles, vote on mole cases
 * (spymasters only), contribute to the tradecraft fund, and attend the
 * tradecraft school. Bots are rejected: citizens act through the brain
 * and the life tick, not the command.
 */

const Guilds = require("./lib/CitizenSpyGuilds");

const COINS_ID = 995;

const SPYGUILD_USAGE =
  "::spyguild [status|join|leave|dues|code|drops|drop <to> <message>|sanctuary|interrogate <spy>|report <name>|cases|vote <caseId> <guilty|innocent>|contribute <amount>|school]";

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
    const has = inv.getAmount?.(COINS_ID) ?? inv.count?.(COINS_ID) ?? 0;
    if (has < amount) return false;
    if (typeof inv.remove === "function") inv.remove(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    else return false;
    return true;
  } catch {
    return false;
  }
}

function onSpyGuildCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the shadow guild through their own sessions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kid = kingdomOf(player);
  const sub = String(args?.[0] || "status").toLowerCase();

  if (sub === "status") {
    if (!kid) { say(player, "You need to be in a kingdom to see its shadow guild."); return; }
    const d = Guilds.describe(kid);
    if (!d) { say(player, "No shadow guild here yet."); return; }
    say(player, `Shadow guild of ${kid}: ${d.members} members (${d.spymasters} spymasters), treasury ${d.treasury} coins, tradecraft fund ${d.tradecraftFund} coins.`);
    say(player, `${d.unreadDrops} sealed drops waiting, ${d.openCases} open mole cases, ${d.hidden} members laying low.`);
    const m = Guilds.memberOf(username);
    if (m) {
      say(player, `You are ${m.rank === "operative" ? "an" : "a"} ${m.rank}${m.suspended ? " (suspended)" : ""}. Dues paid until ${new Date(m.duesPaidUntilMs).toLocaleDateString()}.`);
    } else {
      say(player, "You are not a member. Real spies can ::spyguild join.");
    }
    return;
  }

  if (sub === "join") {
    if (!kid) { say(player, "You need to be in a kingdom to join its shadow guild."); return; }
    const r = Guilds.joinGuild(kid, username);
    if (!r.ok) {
      say(player, r.reason === "not-a-spy"
        ? "Only real spies may join the shadow guild — take the spymaster career, join a spy network, or serve as a counter-agent first."
        : `Could not join: ${r.reason}.`);
      return;
    }
    say(player, `Welcome to the shadows, operative ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week (${Guilds.DUES_TRADECRAFT_SHARE} feeds the tradecraft fund).`);
    return;
  }

  if (sub === "leave") {
    say(player, Guilds.leaveGuild(username) ? "You have left the shadow guild." : "You were not a member.");
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
    say(player, "Dues paid. The tradecraft fund stands a little stronger.");
    return;
  }

  if (sub === "code") {
    say(player, "The tradecraft code:");
    for (const line of Guilds.tradecraftCode()) say(player, `- ${line}`);
    return;
  }

  if (sub === "drops") {
    const r = Guilds.pickupDrops(username);
    if (!r.ok) { say(player, r.reason === "not-a-member" ? "You are not a member." : `Could not check drops: ${r.reason}.`); return; }
    if (!r.drops.length) { say(player, "No sealed drops waiting for you."); return; }
    for (const d of r.drops) {
      say(player, `Sealed drop from ${d.from}: "${d.text}"`);
    }
    return;
  }

  if (sub === "drop") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const to = args?.[1];
    const text = (args || []).slice(2).join(" ");
    if (!to || !text) { say(player, "Usage: ::spyguild drop <name> <message>"); return; }
    const r = Guilds.leaveDrop(kid, username, to, text);
    if (!r.ok) {
      say(player, r.reason === "sender-not-standing" ? "You are not a member in good standing."
        : r.reason === "recipient-not-standing" ? `${to} is not a member in good standing — the guild carries messages for its own only.`
        : r.reason === "no-self-drops" ? "Leave drops for others, not yourself."
        : `Could not leave drop: ${r.reason}.`);
      return;
    }
    say(player, `Sealed drop left for ${to}. Seal it, mark it, walk away.`);
    return;
  }

  if (sub === "sanctuary") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    if (!takeCoins(player, Guilds.SANCTUARY_COST)) {
      say(player, `Laying low costs ${Guilds.SANCTUARY_COST} coins for 7 days of dues-exempt hiding.`);
      return;
    }
    const r = Guilds.layLow(kid, username);
    if (!r.ok) {
      say(player, r.reason === "already-hidden" ? "You are already laying low." : `Could not lay low: ${r.reason}.`);
      return;
    }
    say(player, "You vanish into the safe house. The guild asks no questions and reports nothing.");
    return;
  }

  if (sub === "interrogate") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    if (Guilds.guildRankOf(username) !== Guilds.RANK_SPYMASTER) {
      say(player, "Only spymasters run guild interrogations.");
      return;
    }
    const spy = args?.[1];
    if (!spy) { say(player, "Usage: ::spyguild interrogate <spy>"); return; }
    const r = Guilds.bountyInterrogation(kid, username, spy);
    if (!r.ok) { say(player, `Interrogation failed: ${r.reason}.`); return; }
    say(player, `Interrogation complete: ${r.revealed.length} live operations revealed. Bounty ${r.paid} coins${r.owed ? ` (${r.owed} owed)` : ""}.`);
    return;
  }

  if (sub === "report") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const accused = args?.[1];
    if (!accused) { say(player, "Usage: ::spyguild report <name>"); return; }
    const r = Guilds.reportMisconduct(kid, accused, "mole", username);
    say(player, r.ok ? `Mole case opened: ${r.caseId}.` : `Could not open case: ${r.reason}.`);
    return;
  }

  if (sub === "cases") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const g = Guilds.guildOf(kid);
    if (!g) { say(player, "No shadow guild here yet."); return; }
    const open = Object.entries(g.cases).filter(([, c]) => c.status === "open");
    if (!open.length) { say(player, "No open mole cases."); return; }
    for (const [cid, c] of open) {
      say(player, `${cid}: ${c.accused} accused of being a ${c.kind} (reported by ${c.reporter}).`);
    }
    return;
  }

  if (sub === "vote") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const caseId = args?.[1];
    const how = String(args?.[2] || "").toLowerCase();
    if (!caseId || !["guilty", "innocent", "not"].includes(how)) {
      say(player, "Usage: ::spyguild vote <caseId> <guilty|innocent>");
      return;
    }
    const r = Guilds.voteOnCase(kid, caseId, username, how === "guilty");
    say(player, r.ok ? "Vote recorded." : `Could not vote: ${r.reason}.`);
    return;
  }

  if (sub === "contribute") {
    if (!kid) { say(player, "You need to be in a kingdom."); return; }
    const amount = Math.floor(Number(args?.[1]) || 0);
    if (amount <= 0) { say(player, "Usage: ::spyguild contribute <amount>"); return; }
    if (!takeCoins(player, amount)) { say(player, `You need ${amount} coins.`); return; }
    const r = Guilds.contributeTradecraft(kid, amount);
    say(player, r.ok ? `Contributed ${r.contributed} coins to the tradecraft fund.` : `Contribution failed: ${r.reason}.`);
    return;
  }

  if (sub === "school") {
    const m = Guilds.memberOf(username);
    if (!m) { say(player, "You are not a member."); return; }
    say(player, `Tradecraft school: ${m.trainingCredits || 0} training credits, ${m.interrogationsLed || 0} interrogations led. Spymasters teach; operatives study toward agent (30 days + 2 credits + handler status).`);
    const r = Guilds.tryPromote(username);
    if (r.ok) say(player, `Promoted to ${r.rank}!`);
    return;
  }

  say(player, SPYGUILD_USAGE);
}

module.exports = {
  onSpyGuildCommand,
  SPYGUILD_USAGE,
};
