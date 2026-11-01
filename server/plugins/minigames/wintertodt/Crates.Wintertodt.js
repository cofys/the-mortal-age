"use strict";

/**
 * Opening an extra supply crate, as Ignisia gives them: one roll on the drop table (five if it
 * came from a whole pyromancer outfit). The roll count rides on the crate item's meta so the
 * single non-stackable item can carry it, as live's crate does.
 *
 * Wiki (Extra supply crate): no phoenix, burnt pages or Wintertodt uniques come out of these;
 * the dragon axe is possible. A full inventory drops the overflow, hence the Wiki's "Items may
 * fall to the ground and be lost."
 */

const Shared = require("./Shared.Wintertodt");
const Rewards = require("./Rewards.Wintertodt");

const CRATE_NAME = "Extra supply crate";
const DEFAULT_ROLLS = 1;

function rollsOf(item) {
  const rolls = Number(item?.getMetaValue?.(Shared.CRATE_ROLLS_META));
  return Number.isInteger(rolls) && rolls > 0 ? rolls : DEFAULT_ROLLS;
}

function openCrate(event) {
  const { player, item, slot } = event;
  if (!item || !Number.isInteger(slot)) return false;
  const inventory = player.getInventory();
  const { Item } = Shared.core();
  const rolls = rollsOf(item);
  inventory.setItem(slot, new Item(-1, 0));
  for (let i = 0; i < rolls; i++) {
    const reward = Rewards.rollCrate(player);
    if (!reward) continue;
    inventory.forceAdd(player, new Item(reward.id, reward.amount));
    Shared.api()?.emitCustomEvent("collection-log:obtain", { player, itemId: reward.id, amount: reward.amount });
  }
  inventory.refreshItems();
  return true;
}

module.exports = function registerWintertodtCrates(api) {
  Shared.bind(api);
  api.onItemAction(CRATE_NAME, { Open: openCrate });
};

module.exports.openCrate = openCrate;
module.exports.rollsOf = rollsOf;
