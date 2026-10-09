"use strict";

/**
 * Repair.Economy — paid equipment repair at smith NPCs.
 *
 * NOTE ON LOAD ORDER: this module is required from Economy.plugin.js, which
 * sorts before items/BarrowsEquipment.plugin.js in plugin load order
 * (full-path localeCompare). Both register a "Repair" action on Bob/Dunstan/
 * Tindel Marchant/Aneirin, and the first handler to set event.handled wins.
 * This handler repairs general wear and tear; when the player has NO worn
 * gear it deliberately does NOT handle the event, so BarrowsEquipment's
 * handler runs next and its Barrows-only flow is unchanged.
 *
 * Repair cost is a coin sink: scales with each item's alchemy value.
 */

const wear = require("../items/lib/item-wear");

const SMITH_NPCS = [
  ["Bob", "Repair"],
  ["Aneirin", "Repair"],
  ["Dunstan", "Talk-to"],
  ["Tindel Marchant", "Talk-to"],
];

function wornDamagedItems(player) {
  const items = [];
  const collect = (container) => {
    let entries = [];
    try {
      entries = container.getItems();
    } catch {
      return;
    }
    for (const item of entries) {
      if (
        item &&
        wear.isWearable(item) &&
        wear.getDurability(item) < wear.MAX_DURABILITY
      ) {
        items.push(item);
      }
    }
  };
  try {
    collect(player.getInventory());
    collect(player.getEquipment());
  } catch {
    // ignore
  }
  return items;
}

function totalRepairCost(items) {
  return items.reduce((total, item) => total + wear.repairCost(item), 0);
}

function refresh(player) {
  try {
    player.getInventory().refreshItems();
    player.getEquipment().refreshItems();
  } catch {
    // ignore
  }
}

module.exports = function RepairEconomy(api) {
  function repairAtSmith(event) {
    const { player } = event;
    const items = wornDamagedItems(player);
    const cost = totalRepairCost(items);
    if (cost <= 0) {
      // Not our business — let BarrowsEquipment's Repair handler run.
      return;
    }
    const label = cost.toLocaleString("en-US");
    api.sendMultiChatboxPrompt(
      player,
      `Repair all worn equipment for ${label} coins?`,
      "Repair",
      () => {
        const again = wornDamagedItems(player);
        const finalCost = totalRepairCost(again);
        let coins = 0;
        try {
          coins = player.getInventory().getAmount(995);
        } catch {
          coins = 0;
        }
        if (finalCost <= 0) {
          player.sendMessage("Your equipment is already in pristine condition.");
          return;
        }
        if (coins < finalCost) {
          player.sendMessage(
            `You need ${finalCost.toLocaleString("en-US")} coins to repair your equipment.`
          );
          return;
        }
        player.getInventory().deleteNumber(995, finalCost);
        for (const item of again) wear.setDurability(item, wear.MAX_DURABILITY);
        refresh(player);
        player.sendMessage(
          `Your equipment has been repaired for ${finalCost.toLocaleString("en-US")} coins.`
        );
      },
      "Cancel",
      () => {}
    );
    event.handled = true;
  }

  for (const [npc, option] of SMITH_NPCS) {
    api.onNpcInteraction(npc, { [option]: repairAtSmith });
  }
};
