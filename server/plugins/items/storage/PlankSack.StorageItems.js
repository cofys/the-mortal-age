/**
 * Plank sack (https://oldschool.runescape.wiki/w/Plank_sack; docs/storage-items.md): 28 planks of
 * any kind. Construction builds with the sack's planks after the inventory's, and the sawmill
 * puts planks straight into it. Its count per plank is in the varbits plank_sack_<wood>, which
 * the cache's scripts read. Its contents are kept on death.
 *
 * None of its messages are captured; every line here is ours.
 */
const Storage = require("./Common.StorageItems");

const NAME = "Plank sack";
const CAPACITY = 28;
const MESSAGE = {
  EMPTY: "The plank sack is empty.",
  FULL: "The plank sack is full.",
  NO_PLANKS: "You have no planks to put in the sack.",
};

let planks = null;

/** Plank id -> its varbit id. */
function plankVarbits() {
  if (planks) return planks;
  planks = new Map();
  for (const [name, varbit] of Object.entries(Storage.DATA.planks)) {
    for (const id of Storage.idsOf([name])) planks.set(id, Storage.core.CacheDefinitions.getVarbitId(varbit));
  }
  return planks;
}

/** Sends each plank's count, only when it changed. */
function sendVarbits(player, held = Storage.contents(player, family)) {
  const sender = player.getPacketSender();
  for (const [id, varbit] of plankVarbits()) {
    const amount = held.find((entry) => entry.id === id)?.amount ?? 0;
    if (varbit !== null && sender.getVarbit(varbit) !== amount) sender.sendVarbit(varbit, amount);
  }
}

const family = {
  key: "plank-sack",
  names: [NAME],
  pairs: [],
  usable: () => true,
  accepts: (id) => plankVarbits().has(id),
  room: (_player, _id, held) => CAPACITY - held.reduce((sum, entry) => sum + entry.amount, 0),
  /** Wiki: sawmill planks go in whenever the sack is carried; it has no open state. */
  gathers: (player) => Storage.carried(player, family).length > 0,
  changed: sendVarbits,
  bankEmpty: bankUse,
  /** The bank op fills while the inventory has planks; its label follows (Events.StorageItems.js). */
  bankFills: (player) => Storage.inventoryIds(player).some(family.accepts),
};

function fill({ player }) {
  if (Storage.total(player, family) >= CAPACITY) {
    player.sendMessage(MESSAGE.FULL);
    return;
  }
  const held = Storage.inventoryIds(player).filter(family.accepts);
  if (!held.length) {
    player.sendMessage(MESSAGE.NO_PLANKS);
    return;
  }
  for (const id of held) Storage.fillFrom(player, family, id);
}

function check({ player }) {
  const held = Storage.contents(player, family);
  player.sendMessage(held.length ? `The plank sack contains ${Storage.describe(held).join(", ")}.` : MESSAGE.EMPTY);
}

function empty({ player }) {
  if (Storage.core.Bank.isOpen(player)) return bankUse(player);
  if (Storage.total(player, family) === 0) {
    player.sendMessage(MESSAGE.EMPTY);
    return;
  }
  Storage.emptyToInventory(player, family);
}

/** Wiki: the sack's bank op fills it from the inventory's planks, or with none there, empties it into the bank. */
function bankUse(player) {
  if (family.bankFills(player)) {
    fill({ player });
    Storage.refreshBank(player);
    return;
  }
  if (Storage.total(player, family) === 0) {
    player.sendMessage(MESSAGE.EMPTY);
    return;
  }
  Storage.emptyToBank(player, family);
}

function useOnSack(event) {
  const { player, usedItem, usedWithItem } = event;
  const sack = Storage.nameOf(usedItem) === NAME ? usedItem : Storage.nameOf(usedWithItem) === NAME ? usedWithItem : null;
  const other = sack === usedItem ? usedWithItem : usedItem;
  if (!sack || !family.accepts(other?.getId?.())) return;
  event.handled = true;
  fill({ player });
}

function login({ player }) {
  sendVarbits(player);
}

module.exports = (api) => {
  Storage.register(family);
  api.onItemAction(NAME, { Fill: fill, Check: check, Empty: empty });
  api.onItemOnItem(useOnSack);
  api.onPlayerLogin(login);
};

Object.assign(module.exports, { CAPACITY, MESSAGE });
