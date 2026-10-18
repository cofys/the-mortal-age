"use strict";

/**
 * Digweed: a rare herb that matures in one of the lab's four corner patches (multilocs
 * 55396-55399 on varbits 11330-11333).
 *
 * - Spawning: varbit 11334 counts hand-ins since the last digweed. rsprox captures show it
 *   maturing a few ticks after the hand-in that takes the count to somewhere between 9 and 12
 *   at levels 72-80, and 4 to 7 at 100 and over; the count then goes back to 0. The exact rule
 *   isn't in the captures: the threshold here is drawn from that range by level, and the
 *   herb matures 1-15 ticks after the hand-in that reaches it. Holding digweed stops it (Wiki).
 * - Maturing: "<col=06600c>A herb to the north east has matured..." (north east, south east,
 *   south west, north west by patch). It lasts 20 seconds (Wiki), then "The matured herb has
 *   died."
 * - Collect: picking_low_short, synth 2581 (delay 15), and two ticks later the patch clears,
 *   +1 Digweed and "You collect a handful of digweed." No room: "You don't have enough
 *   inventory space to do that."
 * - Digweed on a potion, unfinished or finished: human_herbing_vial, synth 2608, "You mix the
 *   digweed into the <col=6800bf>Mixalot</col>, drastically improving its quality!" The potion
 *   then pays double XP and resin; a second one is refused (Wiki: "This potion has already
 *   been improved with digweed.").
 * - It can't leave the lab: leaving withers it out of the inventory (Wiki).
 */

const Shared = require("./Shared.Mixology");

const PATCHES = [
  { varbit: Shared.VARBIT.HERB_READY[0], loc: Shared.OBJECT.DIGWEED_MULTI[0], x: 1399, y: 9331, direction: "north east" },
  { varbit: Shared.VARBIT.HERB_READY[1], loc: Shared.OBJECT.DIGWEED_MULTI[1], x: 1399, y: 9322, direction: "south east" },
  { varbit: Shared.VARBIT.HERB_READY[2], loc: Shared.OBJECT.DIGWEED_MULTI[2], x: 1389, y: 9322, direction: "south west" },
  { varbit: Shared.VARBIT.HERB_READY[3], loc: Shared.OBJECT.DIGWEED_MULTI[3], x: 1389, y: 9331, direction: "north west" },
];

const FIELD = { THRESHOLD: "herbThreshold", DUE: "herbDue", EXPIRES: "herbExpires" };
const MATURE_TICKS = 33;
const SPAWN_DELAY = [1, 15];
/** Hand-ins between digweed: 9-12 at level 72, 4-7 at 100 (see above). */
const THRESHOLD = { HIGH_AT_70: 12, LOW_HIGH: 7, LEVEL_FROM: 70, LEVELS: 30, DROP: 5, SPREAD: 3 };
const COLLECT_TICKS = 2;
const SOUND_PICK = 2581;
const SOUND_PICK_DELAY = 15;
const SOUND_MIX = 2608;
const MESSAGE = {
  DIED: "The matured herb has died.",
  COLLECTED: "You collect a handful of digweed.",
  NO_SPACE: "You don't have enough inventory space to do that.",
  ALREADY: "This potion has already been improved with digweed.",
};

function randomBetween(low, high) {
  return low + Math.floor(Math.random() * (high - low + 1));
}

function drawThreshold(player) {
  const level = Shared.herbloreBase(player);
  const drop = Math.round(((level - THRESHOLD.LEVEL_FROM) * THRESHOLD.DROP) / THRESHOLD.LEVELS);
  const high = Math.max(THRESHOLD.LOW_HIGH, Math.min(THRESHOLD.HIGH_AT_70, THRESHOLD.HIGH_AT_70 - drop));
  return randomBetween(high - THRESHOLD.SPREAD, high);
}

function threshold(player) {
  let value = Shared.field(player, FIELD.THRESHOLD);
  if (value === null) {
    value = drawThreshold(player);
    Shared.setField(player, FIELD.THRESHOLD, value);
  }
  return value;
}

function readyPatch(player) {
  return PATCHES.find((patch) => Shared.get(player, patch.varbit) === 1) ?? null;
}

function holdsDigweed(player) {
  return player.getInventory().getAmount(Shared.ITEM.DIGWEED) > 0;
}

/** After each hand-in: once enough orders have gone in, a herb matures shortly. */
function afterHandIn(player) {
  if (Shared.field(player, FIELD.DUE) !== null) return;
  if (Shared.get(player, Shared.VARBIT.ORDERS_SINCE_HERB) < threshold(player)) return;
  Shared.setField(player, FIELD.DUE, Shared.tick() + randomBetween(SPAWN_DELAY[0], SPAWN_DELAY[1]));
}

function mature(player, now) {
  Shared.setField(player, FIELD.DUE, null);
  if (readyPatch(player) || holdsDigweed(player)) return;
  const patch = PATCHES[Math.floor(Math.random() * PATCHES.length)];
  Shared.set(player, Shared.VARBIT.ORDERS_SINCE_HERB, 0);
  Shared.setField(player, FIELD.THRESHOLD, null);
  Shared.set(player, patch.varbit, 1);
  Shared.setField(player, FIELD.EXPIRES, now + MATURE_TICKS);
  player.sendMessage(`<col=${Shared.colours(player).herb}>A herb to the ${patch.direction} has matured...`);
}

function tick(player, now) {
  const due = Shared.field(player, FIELD.DUE);
  if (due !== null && now >= due) mature(player, now);
  const expires = Shared.field(player, FIELD.EXPIRES);
  if (expires === null || now < expires) return;
  Shared.setField(player, FIELD.EXPIRES, null);
  const patch = readyPatch(player);
  if (!patch) return;
  Shared.set(player, patch.varbit, 0);
  player.sendMessage(MESSAGE.DIED);
}

function patchAt(location) {
  return PATCHES.find((patch) => patch.x === location.x && patch.y === location.y) ?? null;
}

function pick(player, patch) {
  if (Shared.get(player, patch.varbit) !== 1) return;
  const inventory = player.getInventory();
  if (inventory.getFreeSlots() < 1) {
    player.sendMessage(MESSAGE.NO_SPACE);
    return;
  }
  Shared.set(player, patch.varbit, 0);
  Shared.setField(player, FIELD.EXPIRES, null);
  inventory.adds(Shared.ITEM.DIGWEED, 1);
  inventory.refreshItems();
  player.sendMessage(MESSAGE.COLLECTED);
}

function collect({ player, location }) {
  const patch = patchAt(location);
  if (!patch || Shared.get(player, patch.varbit) !== 1) return false;
  if (player.getInventory().getFreeSlots() < 1) {
    player.sendMessage(MESSAGE.NO_SPACE);
    return true;
  }
  Shared.animate(player, "picking_low_short");
  Shared.sound(player, SOUND_PICK, SOUND_PICK_DELAY);
  Shared.later(COLLECT_TICKS, () => pick(player, patch));
  return true;
}

/** Digweed used on a potion (either way round). */
function mixIn(event) {
  if (event.handled) return;
  const digweedFirst = event.usedItemId === Shared.ITEM.DIGWEED;
  const potionSlot = digweedFirst ? event.usedWithItemSlot : event.usedItemSlot;
  const digweedSlot = digweedFirst ? event.usedItemSlot : event.usedWithItemSlot;
  const potionId = digweedFirst ? event.usedWithItemId : event.usedItemId;
  if (!digweedFirst && event.usedWithItemId !== Shared.ITEM.DIGWEED) return;
  const entry = Shared.potionByItem(potionId);
  if (!entry) return;
  event.handled = true;
  const { player } = event;
  const inventory = player.getInventory();
  const potionItem = inventory.getItems()[potionSlot];
  if (potionItem?.getMetaValue?.(Shared.META.DIGWEED) === true) {
    player.sendMessage(MESSAGE.ALREADY);
    return;
  }
  potionItem.setMetaValue(Shared.META.DIGWEED, true);
  inventory.deleteAtSlot(digweedSlot, 1, false);
  inventory.refreshItems();
  Shared.animate(player, "human_herbing_vial");
  Shared.sound(player, SOUND_MIX);
  player.sendMessage(`You mix the digweed into the ${Shared.coloured(player, entry.name)}, drastically improving its quality!`);
}

/** Leaving the lab: carried digweed withers and a mature patch is gone. */
function leaveLab(player) {
  const inventory = player.getInventory();
  const carried = inventory.getAmount(Shared.ITEM.DIGWEED);
  if (carried > 0) {
    inventory.delete(Shared.ITEM.DIGWEED, carried);
    inventory.refreshItems();
  }
  const patch = readyPatch(player);
  if (patch) Shared.set(player, patch.varbit, 0);
  Shared.setField(player, FIELD.EXPIRES, null);
  Shared.setField(player, FIELD.DUE, null);
}

module.exports = function attachDigweed(api) {
  api.onObjectInteraction(Shared.OBJECT.DIGWEED, { Collect: collect });
  api.onItemOnItem(mixIn);
};

Object.assign(module.exports, { afterHandIn, tick, leaveLab, threshold, PATCHES });
