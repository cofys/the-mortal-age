"use strict";

/**
 * Commands.Economy — ::economy (OWNER, read-only).
 *
 * Ops visibility into the economy: the sink furnace's lifetime stats, the
 * open demand board, and reference-price reads. Nothing here mutates the
 * world — pricing and demand are driven by events, tuned in constants.js.
 *
 *   ::economy                 — summary: sink stats, open demands, pressured items
 *   ::economy price <itemId>  — reference price for one item (baseline × pressure)
 *   ::economy demands         — list open demand orders (newest first, up to 10)
 */

const Demand = require("./Demand.Economy");
const Prices = require("./Prices.Economy");
const Sinks = require("./Sinks.Economy");
const Fees = require("./Fees.Economy");

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function showSummary(player) {
  const s = Sinks.getStats();
  const f = Fees.getStats();
  player.sendMessage("[Economy] Sink furnace (wilderness PvP deaths):");
  player.sendMessage(
    `  destroyed ${fmt(s.destroyedStacks)} item stacks (~${fmt(s.destroyedValue)} gp reference value) across ${fmt(s.deathsTouched)} deaths`
  );
  player.sendMessage(
    `[Economy] Market fee: ${fmt(f.feesValue)} gp sunk across ${fmt(f.feesCollected)} completed sales (1%).`
  );
  player.sendMessage(
    `[Economy] Demand board: ${Demand.openCount()} open orders; ${Prices.pressuredCount()} items under price pressure.`
  );
  player.sendMessage("[Economy] ::economy price <itemId> | ::economy demands");
}

function showPrice(player, args) {
  const itemId = Math.floor(Number(args[0]));
  if (!Number.isFinite(itemId) || itemId <= 0) {
    player.sendMessage("Usage: ::economy price <itemId>");
    return;
  }
  const baseline = Prices.getBaseline(itemId);
  const reference = Prices.getReferencePrice(itemId);
  player.sendMessage(`[Economy] item ${itemId}: reference ${fmt(reference)} gp (baseline ${fmt(baseline)} gp).`);
}

function showDemands(player) {
  const open = Demand.getOpen().slice(0, 10);
  if (open.length === 0) {
    player.sendMessage("[Economy] Demand board is empty.");
    return;
  }
  player.sendMessage(`[Economy] Open demand (${open.length} shown):`);
  for (const d of open) {
    const items = d.items
      .map((i) => `${i.amount}x #${i.itemId}${i.priceEach ? ` @ ${fmt(i.priceEach)}` : ""}`)
      .join(", ");
    player.sendMessage(`  [${d.id}] ${d.source}${d.kingdomId ? ` (${d.kingdomId})` : ""}: ${items}`);
  }
}

function onEconomyCommand({ player, parts }) {
  const sub = String(parts?.[1] ?? "").toLowerCase();
  const args = (parts ?? []).slice(2);
  if (sub === "price") return showPrice(player, args);
  if (sub === "demands") return showDemands(player);
  return showSummary(player);
}

module.exports = function attachCommands(api) {
  api.registerCommand("economy", onEconomyCommand, api.core.PlayerRights.OWNER, "Economy status: ::economy [price <id>|demands]");
};

module.exports.onEconomyCommand = onEconomyCommand;
