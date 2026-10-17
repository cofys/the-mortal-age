/**
 * Graceful outfit (Wiki): each piece gives its own run-energy restoration bonus
 * (hood 3%, top/legs 4%, gloves/boots/cape 3% - 20% total) and wearing all six
 * pieces adds another 10%, for 30%. The Agility cape (or a max cape) substitutes
 * for the graceful cape for the set effect.
 */
const PIECES = [
  { slot: 0, prefix: "Graceful hood", percent: 0.03 },
  { slot: 4, prefix: "Graceful top", percent: 0.04 },
  { slot: 7, prefix: "Graceful legs", percent: 0.04 },
  { slot: 9, prefix: "Graceful gloves", percent: 0.03 },
  { slot: 10, prefix: "Graceful boots", percent: 0.03 },
  { slot: 1, prefix: "Graceful cape", percent: 0.03 },
];
const SET_BONUS = 0.10;

let coreApi;
let pluginApi;

/** An Agility cape (or max cape) at the cape slot counts as a graceful cape for the set effect. */
function capeIsSubstitute(player) {
  const request = { player, skill: "AGILITY", result: false };
  pluginApi.emitCustomEvent("skillcape:has-perk", request);
  return request.result === true;
}

function itemName(item) {
  const id = item?.getId?.() ?? -1;
  if (id <= 0) {
    return null;
  }
  return coreApi.ItemDefinition.forId(id)?.getName?.() ?? null;
}

/** Pure bonus calculation so it can be tested without a full player. */
function gracefulRestoreBonusFromSlots(nameBySlot, capeIsSubstitute) {
  let bonus = 0;
  let pieces = 0;
  for (const piece of PIECES) {
    const name = nameBySlot[piece.slot];
    if (name && String(name).startsWith(piece.prefix)) {
      bonus += piece.percent;
      pieces++;
    }
  }
  if (pieces === 0) {
    return 0;
  }
  // Six graceful pieces, or five plus an Agility/max cape at the cape slot.
  if (pieces === PIECES.length || (pieces === PIECES.length - 1 && capeIsSubstitute)) {
    bonus += SET_BONUS;
  }
  return bonus;
}

function energyRestoreBonus(player) {
  const equipment = player.getEquipment().getItems();
  const nameBySlot = {};
  for (const piece of PIECES) {
    nameBySlot[piece.slot] = itemName(equipment[piece.slot]);
  }
  return gracefulRestoreBonusFromSlots(nameBySlot, capeIsSubstitute(player));
}

/** The core delay is milliseconds per energy point; a bigger rate means a shorter delay. */
function applyGracefulRunEnergy(player, delayMs) {
  const bonus = energyRestoreBonus(player);
  return bonus > 0 ? delayMs / (1 + bonus) : delayMs;
}

module.exports = {
  name: "GracefulOutfit",
  members: true,
  _test: { gracefulRestoreBonusFromSlots, energyRestoreBonus },
  register(api) {
    coreApi = api.core;
    pluginApi = api;
    api.registerRunEnergyRestoreModifier(applyGracefulRunEnergy);
  },
};
