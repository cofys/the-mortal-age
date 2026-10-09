"use strict";

/**
 * CitizenObservatoryGuildEvents — player-facing Astronomers' Guild: the ::obsguild command.
 *
 * Mirrors the ::libguild command pattern (PlayerRights.NONE so every
 * player can use it). Players can join the guild, pay dues, submit star
 * charts for guild certification, report suspected fabrications, vote on
 * tribunal cases, publish celestial predictions, review open predictions,
 * arrange mentorship, and contribute to the guild treasury. Bots are
 * rejected: citizens act through the brain and the life tick, not the
 * command.
 */

const Guilds = require("./lib/CitizenObservatoryGuilds");

const COINS_ID = 995;

const OBSGUILD_USAGE =
  "::obsguild [status|join|leave|dues|code|certify <chartId>|charts|report <chartId>|cases|vote <caseId> <guilty|innocent>|orrery|predict [event]|predictions|school|apprentice <name>|contribute <coins>|audit]";

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

function monthLabel(ms) {
  try {
    return new Date(ms).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return "an upcoming month";
  }
}

function onObservatoryGuildCommand(player, args) {
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
        say(player, "No Astronomers' Guild hall here yet.");
        return;
      }
      const m = Guilds.memberOf(username);
      const audit = Guilds.accuracyAuditFor(kingdomId);
      say(player, `Astronomers' Guild — ${desc.memberCount} members, ` +
        `${desc.certified} certified charts. Celestial accuracy: ${audit.score}/100. ` +
        `Treasury: ${desc.treasury} coins. Prestige: ${desc.prestige}. ` +
        `Predictions: ${desc.openPredictions} open, ${desc.confirmedPredictions} confirmed.` +
        (m ? ` You are ${m.rank === "starmaster" ? "a" : m.rank === "astronomer" ? "an" : "a"} ${m.rank}${m.suspended ? " (suspended)" : ""}.` : " You are not a member."));
      return;
    }
    case "join": {
      const res = Guilds.joinGuild(username, kingdomId);
      say(player, res.ok ? `Welcome to the Astronomers' Guild, ${username}. Dues are ${Guilds.DUES_WEEKLY} coins a week.`
        : `Could not join: ${res.reason}.`);
      return;
    }
    case "leave": {
      const res = Guilds.leaveGuild(username);
      say(player, res.ok ? "You have left the Astronomers' Guild." : `Could not leave: ${res.reason}.`);
      return;
    }
    case "dues": {
      const m = Guilds.memberOf(username);
      if (!m) { say(player, "You are not a guild member."); return; }
      if ((m.duesPaidUntilMs || 0) > Date.now()) {
        say(player, "Your dues are paid up.");
        return;
      }
      if (!takeCoins(player, Guilds.DUES_WEEKLY)) {
        say(player, `You need ${Guilds.DUES_WEEKLY} coins for dues.`);
        return;
      }
      Guilds.recordDuesPayment(username, Date.now());
      say(player, "Dues paid. Thank you for supporting the guild.");
      return;
    }
    case "code": {
      say(player, "The Astronomers' Code: (1) Chart true — never claim another's sky. " +
        "(2) Predict honestly — the sky keeps its own ledger. (3) Teach the young. " +
        "(4) Keep the standard. (5) Pay your dues.");
      return;
    }
    case "certify": {
      // ::obsguild certify <chartId>
      const chartId = rest[0];
      if (!chartId) {
        say(player, "Usage: ::obsguild certify <chartId>");
        return;
      }
      const m = Guilds.memberOf(username);
      if (!m) { say(player, "You are not a guild member."); return; }
      if (m.suspended) { say(player, "You are suspended — catch up on dues first."); return; }
      const res = Guilds.certifyChart(kingdomId, username, chartId);
      if (!res.ok) {
        if (res.reason === "not-the-astronomer") {
          say(player, `That chart is not yours — a fabrication case (${res.caseId}) has been opened.`);
        } else {
          say(player, `Certification failed: ${res.reason}.`);
        }
        return;
      }
      say(player, `Chart certified! Grade ${res.grade}. ` +
        (res.bountyPaid > 0 ? `Bounty paid: ${res.bountyPaid} coins.` : "") +
        (res.bountyOwed > 0 ? ` Bounty owed: ${res.bountyOwed} coins (the guild will pay when funds allow).` : ""));
      return;
    }
    case "charts": {
      const grade = Guilds.bestGradeFor(username);
      if (!grade) { say(player, "You have no certified charts."); return; }
      say(player, `Your best certification grade: ${grade}.`);
      return;
    }
    case "report": {
      const chartId = rest[0];
      if (!chartId) { say(player, "Usage: ::obsguild report <chartId>"); return; }
      const res = Guilds.reportFabrication(kingdomId, username, chartId);
      say(player, res.ok ? `Fabrication case opened: ${res.caseId}. Astronomers will vote.`
        : `Could not open case: ${res.reason}.`);
      return;
    }
    case "cases": {
      const st = Guilds.load();
      const open = Object.values(st.cases || {}).filter((c) => c.kingdomId === kingdomId && c.status === "open");
      if (!open.length) { say(player, "No open tribunal cases."); return; }
      say(player, open.map((c) => `${c.id}: fabrication over chart ${c.chartId} (recorded astronomer: ${c.recordedAstronomer}, ${Object.keys(c.votes).length} votes)`).join(" | "));
      return;
    }
    case "vote": {
      const [caseId, verdict] = rest;
      if (!caseId || !verdict) { say(player, "Usage: ::obsguild vote <caseId> <guilty|innocent>"); return; }
      const res = Guilds.voteOnCase(caseId, username, verdict.toLowerCase());
      say(player, res.ok ? "Vote recorded." : `Could not vote: ${res.reason}.`);
      return;
    }
    case "orrery": {
      const g = Guilds.guildOf(kingdomId);
      say(player, g ? "The silver orrery is awarded quarterly to the most-certified member." : "No guild hall here yet.");
      return;
    }
    case "predict": {
      // ::obsguild predict [lunar_eclipse|solar_eclipse|comet|meteor_shower]
      const kind = rest.join("_").toLowerCase().replace(/\s+/g, "_") || "lunar_eclipse";
      const preview = Guilds.nextEventFor(kind);
      if (!preview) {
        say(player, "Unknown event. Try: lunar_eclipse, solar_eclipse, comet, meteor_shower.");
        return;
      }
      const res = Guilds.predictEvent(kingdomId, username, kind);
      if (!res.ok) {
        say(player, `Could not publish prediction: ${res.reason}.`);
        return;
      }
      say(player, `Prediction published: a ${res.label} in ${monthLabel(res.predictedForMs)}. ` +
        `The sky will judge — a confirmed prediction pays ${Guilds.HERALD_PRIZE} coins.`);
      return;
    }
    case "predictions": {
      const preds = Guilds.predictionsFor(kingdomId);
      if (!preds.length) { say(player, "No predictions on the guild's ledger."); return; }
      say(player, preds.slice(0, 5).map((p) =>
        `${p.label} in ${monthLabel(p.predictedForMs)} by ${p.predictedBy} (${p.status})`).join(" | "));
      return;
    }
    case "school": {
      say(player, "The star-chart school: starmasters teach stargazers. Attend guild sessions to earn training credits.");
      return;
    }
    case "apprentice": {
      const novice = rest.join(" ");
      if (!novice) { say(player, "Usage: ::obsguild apprentice <name>"); return; }
      const res = Guilds.takeApprentice(username, novice);
      say(player, res.ok ? `${novice} is now your apprentice.` : `Could not take apprentice: ${res.reason}.`);
      return;
    }
    case "contribute": {
      const amount = parseInt(rest[0], 10);
      if (!amount || amount <= 0) { say(player, "Usage: ::obsguild contribute <coins>"); return; }
      if (!takeCoins(player, amount)) { say(player, "You don't have that many coins."); return; }
      Guilds.contributeToFund(kingdomId, amount);
      say(player, `Thank you! ${amount} coins added to the guild treasury.`);
      return;
    }
    case "audit": {
      const audit = Guilds.accuracyAuditFor(kingdomId);
      say(player, `Celestial accuracy: ${audit.score}/100 — ${audit.withCharts} of ${audit.members} members hold real certified charts.` +
        (audit.withDiscoveries > 0 ? ` ${audit.withDiscoveries} hold real astronomy discoveries.` : ""));
      return;
    }
    default:
      say(player, OBSGUILD_USAGE);
      return;
  }
}

module.exports = { onObservatoryGuildCommand, OBSGUILD_USAGE };
