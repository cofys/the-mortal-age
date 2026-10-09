"use strict";

/**
 * CitizenTradeCharterEvents — player-facing trade charters: the ::charter command.
 *
 * Mirrors the ::spy / ::treaty command pattern (PlayerRights.NONE so every
 * player can use it). Players can list active charters, petition their guild
 * for a charter (real coins from their real inventory), and check tolls and
 * guild treasuries. Bots are rejected: citizens charter through the brain,
 * not the command.
 */

const Charters = require("./lib/CitizenTradeCharters");

const USAGE =
  "Trade charters: ::charter [list|petition <guild> <kingdom> <category>|toll <kingdom> <category>|treasury <guild>]";

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

function onCharterCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens petition for charters through their guilds, not commands.");
    return;
  }
  const username = usernameOf(player);
  const sub = String(args?.[0] ?? "list").toLowerCase();

  if (sub === "list") {
    const active = Charters.activeCharters();
    if (!active.length) {
      say(player, "No trade charters are currently granted. The markets are open to all.");
      return;
    }
    say(player, `Active trade charters (${active.length}):`);
    for (const c of active.slice(0, 10)) {
      const cat = Charters.categoryFor(c.category);
      const days = Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 86400000));
      say(player, `- ${cat?.label ?? c.category} in ${c.kingdomId}: ${c.guildId === "merchants" ? "Merchants'" : "Crafters'"} Guild (${days}d left)`);
    }
    return;
  }

  if (sub === "petition") {
    const guildId = String(args?.[1] ?? "").toLowerCase();
    const kingdomId = String(args?.[2] ?? "").toLowerCase();
    const category = String(args?.[3] ?? "").toLowerCase();
    if (!guildId || !kingdomId || !category) {
      say(player, `Usage: ::charter petition <merchants|crafters> <kingdom> <category> (${Charters.CHARTER_FEE} coins fee)`);
      return;
    }
    const res = Charters.petitionCharter(username, guildId, kingdomId, category, player);
    if (!res.ok) {
      say(player, `Charter petition failed: ${res.reason}.`);
      return;
    }
    const cat = Charters.categoryFor(category);
    say(player, `Granted! The ${guildId === "merchants" ? "Merchants'" : "Crafters'"} Guild now holds the exclusive ${cat?.label ?? category} trade charter in ${kingdomId} for 30 days.`);
    return;
  }

  if (sub === "toll") {
    const kingdomId = String(args?.[1] ?? "").toLowerCase();
    const category = String(args?.[2] ?? "").toLowerCase();
    if (!kingdomId || !category) {
      say(player, "Usage: ::charter toll <kingdom> <category>");
      return;
    }
    const bps = Charters.tollBpsFor(kingdomId, category);
    if (!bps) {
      say(player, `No charter covers ${category} in ${kingdomId} — no toll.`);
      return;
    }
    const holder = Charters.charterHolder(kingdomId, category);
    const exempt = Charters.memberExempt(username);
    say(player, `${category} in ${kingdomId} is chartered to the ${holder === "merchants" ? "Merchants'" : "Crafters'"} Guild: ${(bps / 100).toFixed(1)}% toll on non-guild sales.${exempt ? " You are exempt as a guild member." : ""}`);
    return;
  }

  if (sub === "treasury") {
    const guildId = String(args?.[1] ?? "").toLowerCase();
    if (!["merchants", "crafters"].includes(guildId)) {
      say(player, "Usage: ::charter treasury <merchants|crafters>");
      return;
    }
    say(player, `The ${guildId === "merchants" ? "Merchants'" : "Crafters'"} Guild treasury holds ${Charters.treasuryFor(guildId).toLocaleString()} coins from charter tolls.`);
    return;
  }

  say(player, USAGE);
}

module.exports = {
  onCharterCommand,
  CHARTER_USAGE: USAGE,
};
