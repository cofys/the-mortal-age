"use strict";

/**
 * Commands.Myreque — dev-only ::myreque (DEVELOPER rank, never for players).
 *
 * Jon's rule: no ::commands for players — reputation is earned and shown
 * through the world. This is the dev hatch for testing the track:
 *
 *   ::myreque get <player>        — standing and tier
 *   ::myreque set <player> <n>    — set standing (-1000..1000)
 *   ::myreque add <player> <n>    — move the needle (fires crossings)
 *   ::myreque tier <player>       — tier name, title, lock state
 */

const Rep = require("./Reputation.Myreque");

let api = null;

function targetOf(player, args) {
  const name = args[1];
  if (!name) {
    player.sendMessage("[Myreque] Usage: ::myreque get|set|add|tier <player> [value]");
    return null;
  }
  const target = api.core.World.getPlayerByName?.(name);
  if (!target) {
    player.sendMessage(`[Myreque] No online player named '${name}'.`);
    return null;
  }
  return target;
}

function describe(target) {
  const standing = Rep.getStanding(target);
  const tier = Rep.tierOf(standing);
  const title = Rep.titleFor(target);
  const locks = [
    Rep.myrequeLocked(target) ? "myreque-locked" : null,
    Rep.drakanLocked(target) ? "drakan-locked" : null,
  ].filter(Boolean).join(", ") || "none";
  return `${target.getUsername?.() ?? "?"}: standing ${standing}, tier ${tier}${title ? ` ("${title}")` : ""}, locks: ${locks}`;
}

function onMyrequeCommand(player, args) {
  const sub = String(args[0] ?? "get").toLowerCase();
  if (sub === "get" || sub === "tier") {
    const target = targetOf(player, args);
    if (target) player.sendMessage("[Myreque] " + describe(target));
    return;
  }
  if (sub === "set" || sub === "add") {
    const target = targetOf(player, args);
    if (!target) return;
    const value = Number(args[2]);
    if (!Number.isFinite(value)) {
      player.sendMessage("[Myreque] Usage: ::myreque set|add <player> <number>");
      return;
    }
    // Route through addStanding so tier crossings fire their effects.
    const delta = sub === "set" ? (value | 0) - Rep.getStanding(target) : value | 0;
    const after = Rep.addStanding(target, delta, "dev");
    player.sendMessage(`[Myreque] ${target.getUsername?.() ?? "?"} standing now ${after}.`);
    player.sendMessage("[Myreque] " + describe(target));
    return;
  }
  player.sendMessage("[Myreque] Usage: ::myreque get|set|add|tier <player> [value]");
}

function registerCommands(pluginApi) {
  api = pluginApi;
  api.registerCommand(
    "myreque",
    onMyrequeCommand,
    api.core.PlayerRights.DEVELOPER,
    "Myreque reputation dev tools: ::myreque get|set|add|tier <player> [value]"
  );
  console.info("[myreque] dev command registered (::myreque, DEVELOPER only)");
}

module.exports = registerCommands;
