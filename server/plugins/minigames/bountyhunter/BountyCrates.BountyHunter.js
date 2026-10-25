"use strict";

/**
 * Opening bounty crates (OSRS Wiki: Bounty crate (tier 1) ... (tier 9)): coins and noted blighted
 * super restores always, one noted blighted food, and a 1/10 roll on the ancient artefacts table.
 */

const CRATES = require("./data/bounty-crates.json");

let core;

function between([min, max], random) {
  return min + Math.floor(random() * (max - min + 1));
}

function pickWeighted(entries, random) {
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [name, weight] of entries) {
    roll -= weight;
    if (roll < 0) return name;
  }
  return entries[entries.length - 1][0];
}

/** The crate's loot as [ItemIdentifiers name, amount, noted] rows. */
function rollCrate(tier, random = Math.random) {
  const table = CRATES.tiers[tier - 1];
  const loot = [
    ["COINS", between(table.coins, random), false],
    [CRATES.restore, between(table.restores, random), true],
    [CRATES.food[Math.floor(random() * CRATES.food.length)], between(table.food, random), true],
  ];
  if (random() * CRATES.artefactChance < 1) loot.push([pickWeighted(CRATES.artefacts, random), 1, false]);
  return loot;
}

function openCrate({ player, itemId, slot }) {
  const tier = Number(/\(tier (\d+)\)/.exec(core.ItemDefinition.forId(itemId).getName())?.[1]);
  if (!tier) return false;
  const inventory = player.getInventory();
  inventory.setItem(slot, new core.Item(-1, 0));
  for (const [name, amount, noted] of rollCrate(tier)) {
    const id = core.ItemIdentifiers[name];
    inventory.forceAdd(player, new core.Item(noted ? core.ItemDefinition.forId(id).getNoteId() : id, amount));
  }
  inventory.refreshItems();
  return true;
}

module.exports = function attachBountyHunterCrates(api) {
  core = api.core;
  for (let tier = 1; tier <= CRATES.tiers.length; tier++) {
    api.onItemAction(`Bounty crate (tier ${tier})`, { Open: openCrate });
  }
};
Object.assign(module.exports, { rollCrate });
