"use strict";

const GEAR = require("./data/bot-gear.json");
const { canEquipPresetItem } = require("../../modes/pvp/Presets.PvpMode");

let core;
let bh;
let upgrades;

/** Upgrade eligible crater presets before the shared engine equips and indexes their specs. */
function upgradeLoadout({ player, preset }) {
  if (!bh.isArenaTile(player.getLocation())) return;
  const upgrade = (item) => {
    const id = upgrades.get(item?.getId());
    if (id === undefined) return item;
    const upgraded = new core.Item(id, item.getAmount());
    return canEquipPresetItem(preset, upgraded) ? upgraded : item;
  };
  preset.setEquipment(preset.getEquipment().map(upgrade));
  preset.setInventory(preset.getInventory().map(upgrade));
}

module.exports = function attachLoadouts(api, state) {
  core = api.core;
  bh = state;
  upgrades = new Map(Object.entries(GEAR).map(([from, to]) => {
    const source = core.ItemIdentifiers[from], target = core.ItemIdentifiers[to];
    if (!Number.isInteger(source) || !Number.isInteger(target)) throw new Error(`Unknown Bounty Hunter bot gear: ${from}/${to}`);
    return [source, target];
  }));
  api.onCustomEvent("player-bots:pvp-loadout", upgradeLoadout);
};
