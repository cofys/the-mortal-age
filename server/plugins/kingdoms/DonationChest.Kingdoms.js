"use strict";

/**
 * DonationChest — DIEGETIC ::donate replacement (no-commands migration, phase 4).
 *
 * Jon's directive: no ::commands for players. Everything through the world.
 * A "Donation chest" stands in each capital. Click "Donate" and a chatbox
 * prompt offers preset amounts (1k / 10k / 100k / 1M); the coins move through
 * the same donateToKingdom() the ::donate command uses, so the war treasury,
 * trial-of-service progress, and the kingdom:donation-made event all behave
 * identically no matter which path the player took.
 *
 * The chest's kingdom is inferred from the donor's position — the same
 * market-square table as the Market Board's kingdomAt (a chest serves the
 * capital it stands in). The shared donate logic still enforces membership:
 * you can only fund a war you serve.
 *
 * The ::donate command stays registered until the chest is verified in-game,
 * then it goes. Migration rule: build the world path, verify it works,
 * remove the command. Never the reverse.
 *
 * NOTE: the physical chests are a world edit — same as the Market Board's
 * "place a board in each capital market" step. This file is the interaction.
 * Verify: place a "Donation chest" in a capital, click Donate, pick an
 * amount, confirm coins leave the purse and the kingdom treasury grows.
 */

const Politics = require("./Politics.Kingdoms");
const Store = require("./KingdomStore");

const CHEST_OBJECT_NAME = "Donation chest";

/** Preset gifts, coins. */
const PRESET_AMOUNTS = [1000, 10000, 100000, 1000000];

let pluginApi = null;

/**
 * Which kingdom's capital is this chest in? Mirrors the Market Board's
 * kingdomAt table (MarketBoard.Shops.js): market squares near each capital's
 * trade hub, 60-tile radius. A donation chest serves the capital it stands in.
 */
function kingdomAt(player) {
  try {
    const pos = player.getLocation?.();
    const x = pos.getX?.() ?? 0;
    const y = pos.getY?.() ?? 0;
    const capitals = [
      { id: "asgarnia", x: 2964, y: 3378 },
      { id: "misthalin", x: 3165, y: 3485 },
      { id: "kandarin", x: 2660, y: 3290 },
      { id: "morytania", x: 3495, y: 3235 },
      { id: "keldagrim", x: 2855, y: 10200 },
    ];
    let best = null;
    let bestD = 60; // must be within 60 tiles of a capital
    for (const c of capitals) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function formatCoins(n) {
  return n.toLocaleString("en-US");
}

function openDonationPrompt({ player }) {
  if (!player || player.isPlayerBot?.() === true) return;
  const kingdomId = kingdomAt(player);
  if (!kingdomId) {
    player.sendMessage("This chest serves no court I know. Try a capital.");
    return;
  }
  const name = Store.getKingdom(kingdomId)?.name ?? kingdomId;
  const options = [];
  for (const amount of PRESET_AMOUNTS) {
    options.push(`${formatCoins(amount)} coins`, () => {
      Politics.donateToKingdom(player, kingdomId, amount);
    });
  }
  options.push("Never mind.", () => {});
  try {
    pluginApi.sendMultiChatboxPrompt(
      player,
      `Donate to the ${name} war effort?`,
      ...options
    );
  } catch (error) {
    console.warn("[donation-chest] prompt failed", error?.message ?? error);
    player.sendMessage("The chest's lid sticks. Try again.");
  }
}

function attachDonationChest(api) {
  pluginApi = api;
  // Diegetic: the chest is a spawned Closed chest (DiegeticObjects).
  // Global handler + location gate; the "Donation chest" name doesn't
  // exist in the cache.
  const { matchDiegetic } = require("../world/DiegeticObjects");
  api.onObjectInteraction((event) => {
    const { player, objectId, location } = event ?? {};
    if (!player || player.isPlayerBot?.() === true) return false;
    if (!matchDiegetic(objectId, location, "chest")) return false;
    openDonationPrompt({ player });
    return true;
  });
  console.info("[donation-chest] diegetic ::donate replacement ready (phase 4)");
}

module.exports = attachDonationChest;
