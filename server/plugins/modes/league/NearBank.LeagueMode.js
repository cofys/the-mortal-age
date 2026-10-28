/**
 * Whether a Shattered Relics character stands in a bank (data/league-shattered.json `bank`): where
 * fragments change (Fragments, Wiki /Fragments) and quest packs auto-complete (Unlocks, the
 * league's launch news: "you can only auto-complete quests while in a Bank").
 */
const Common = require("./Common.LeagueMode");
const { data } = require("./Shattered.LeagueMode");

function config() {
  return data.bank;
}

/** A loc that banks: one with a Bank option (booths, counters, tables), or a bank chest you can use. */
function banksAt(object) {
  const definition = object.getDefinition?.();
  const actions = definition?.getActions?.() ?? [];
  const { bankAction, bankChests } = config();
  return actions.includes(bankAction) || (bankChests.includes(definition?.getName?.()) && actions.some(Boolean));
}

/** A loc that banks, or an NPC with a Bank option, within `bank.distance` on the character's plane. */
function nearBank(player) {
  const { bankAction, distance } = config();
  const { MapObjects, RegionManager } = Common.core;
  const here = player.getLocation();
  const [x, y, z] = [here.getX(), here.getY(), here.getZ()];
  RegionManager.loadMapFiles(x, y);
  for (let dx = -distance; dx <= distance; dx++) {
    for (let dy = -distance; dy <= distance; dy++) {
      const objects = MapObjects.mapObjects.get(MapObjects.getHash(x + dx, y + dy, z)) ?? [];
      if (objects.some(banksAt)) return true;
    }
  }
  const list = player.getLocalNpcs?.();
  const npcs = Array.isArray(list) ? list : list ? [...list.values()] : [];
  return npcs.some((npc) => (npc?.getDefinition?.()?.getActions?.() ?? []).includes(bankAction)
    && npc.getLocation().getZ() === z && here.getDistance(npc.getLocation()) <= distance);
}

module.exports = { nearBank, banksAt };
