"use strict";

/**
 * The refiner beside the bank chest, and the hopper above the mixers.
 *
 * - Refiner (Operate): each herb or unfinished potion becomes paste (data/mastering-mixology.json,
 *   Wiki), with 6 Herblore XP. A click refines one at once and the refiner then works through
 *   the rest every second tick (rsprox captures 4186, 4187: human_alchemy01_mill01_interact01
 *   with -1 herb and +20 Mox paste on each), so clicking every tick doubles the rate (Wiki).
 * - Hopper (Deposit, or paste used on it): every paste the player carries goes into the mixer
 *   up to 3,000 of each (varbits 11431-11433), with human_alchemy01_hopper01_interact01,
 *   synth 2739 and a message box listing what went in ("You deposit the following into the
 *   mixer:<br>410 Mox paste<br>400 Aga paste"). Captured refusals: "The mixer can't hold any
 *   more of the paste you're carrying." and "You'll need some Mox, Aga or Lyre paste to
 *   deposit here." (sic).
 */

const Shared = require("./Shared.Mixology");

const REFINE_XP = 6;
const REFINE_TICKS = 2;
const SOUND_HOPPER = 2739;
const MESSAGE = {
  DEPOSITED: "You deposit the following into the mixer:",
  HOPPER_FULL: "The mixer can't hold any more of the paste you're carrying.",
  NO_PASTE: "You'll need some Mox, Aga or Lyre paste to deposit here.",
  /** Not captured. */
  NOTHING_TO_REFINE: "You have nothing that can be refined.",
};

let refinables = null;

/** Item id -> [reagent, paste]. */
function refinable() {
  if (refinables) return refinables;
  const { ItemIdentifiers } = Shared.core();
  refinables = new Map();
  for (const [name, entry] of Object.entries(Shared.DATA.refiner)) {
    const id = ItemIdentifiers[name];
    if (Number.isInteger(id)) refinables.set(id, entry);
  }
  return refinables;
}

/** The refining in progress, so a move or another click ends the old loop. */
const refining = new WeakMap();

function firstRefinable(player) {
  const items = player.getInventory().getItems();
  for (let slot = 0; slot < items.length; slot++) {
    const entry = refinable().get(items[slot]?.getId?.());
    if (entry) return { slot, entry };
  }
  return null;
}

function refineOne(player) {
  const found = firstRefinable(player);
  if (!found) return false;
  const [reagent, paste] = found.entry;
  const inventory = player.getInventory();
  inventory.deleteAtSlot(found.slot, 1);
  inventory.adds(Shared.ITEM.PASTE[reagent], paste);
  inventory.refreshItems();
  Shared.animate(player, "human_alchemy01_mill01_interact01");
  Shared.addXp(player, REFINE_XP);
  return true;
}

function operateRefiner({ player, objectId }) {
  if (objectId !== Shared.OBJECT.REFINER_ID) return false;
  if (!refineOne(player)) {
    player.sendMessage(MESSAGE.NOTHING_TO_REFINE);
    return;
  }
  const { Task, TaskManager } = Shared.core();
  const run = { tile: player.getLocation().clone() };
  refining.set(player, run);
  TaskManager.submit(new (class extends Task {
    constructor() { super(REFINE_TICKS, player, false); }
    execute() {
      const location = player.getLocation();
      const moved = location.getX() !== run.tile.getX() || location.getY() !== run.tile.getY();
      if (!player.isRegistered() || refining.get(player) !== run || moved || !refineOne(player)) {
        if (refining.get(player) === run) refining.delete(player);
        this.stop();
      }
    }
  })());
  return true;
}

function deposit(player) {
  const inventory = player.getInventory();
  const carried = Shared.REAGENTS.filter((reagent) => inventory.getAmount(Shared.ITEM.PASTE[reagent]) > 0);
  if (!carried.length) {
    Shared.statement(player, MESSAGE.NO_PASTE);
    return;
  }
  const lines = [];
  for (const reagent of carried) {
    const varbit = Shared.VARBIT.AVAILABLE[reagent];
    const room = Shared.HOPPER_CAPACITY - Shared.get(player, varbit);
    const amount = Math.min(room, inventory.getAmount(Shared.ITEM.PASTE[reagent]));
    if (amount <= 0) continue;
    inventory.delete(Shared.ITEM.PASTE[reagent], amount);
    Shared.set(player, varbit, Shared.get(player, varbit) + amount);
    lines.push(`${Shared.formatNumber(amount)} ${Shared.REAGENT_NAME[reagent]} paste`);
  }
  if (!lines.length) {
    Shared.statement(player, MESSAGE.HOPPER_FULL);
    return;
  }
  inventory.refreshItems();
  Shared.animate(player, "human_alchemy01_hopper01_interact01");
  Shared.sound(player, SOUND_HOPPER);
  Shared.statement(player, [MESSAGE.DEPOSITED, ...lines].join("<br>"));
}

function depositAll({ player, objectId }) {
  if (objectId !== Shared.OBJECT.HOPPER_ID) return false;
  deposit(player);
  return true;
}

function pasteOnHopper({ player, objectId }) {
  if (objectId !== Shared.OBJECT.HOPPER_ID) return false;
  deposit(player);
  return true;
}

module.exports = function attachRefiner(api) {
  api.onObjectInteraction(Shared.OBJECT.REFINER, { Operate: operateRefiner });
  api.onObjectInteraction(Shared.OBJECT.HOPPER, { Deposit: depositAll });
  api.onItemOnObject("Mox paste", Shared.OBJECT.HOPPER, pasteOnHopper);
  api.onItemOnObject("Aga paste", Shared.OBJECT.HOPPER, pasteOnHopper);
  api.onItemOnObject("Lye paste", Shared.OBJECT.HOPPER, pasteOnHopper);
};
