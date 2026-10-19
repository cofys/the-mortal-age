/**
 * Gem bag (https://oldschool.runescape.wiki/w/Gem_bag; docs/storage-items.md): 60 of each uncut
 * sapphire, emerald, ruby, diamond and dragonstone. Open, it takes the gems a player picks up,
 * steals or gets while mining. Its contents are kept on death.
 */
const Storage = require("./Common.StorageItems");

const NAMES = ["Gem bag", "Open gem bag"];
const PER_GEM = 60;
/** Wiki: Fill's message. */
const FILLED = "You add the gems to your bag.";
/** Wiki: a gem going straight into the open bag. */
const STRAIGHT_IN = "You put it straight into your open gem bag.";
const MESSAGE = {
  /** Ours (not captured). */
  EMPTY: "The gem bag is empty.",
  /** Ours (not captured). */
  NO_GEMS: "You have no uncut gems to put in the bag.",
  /** Ours (not captured). */
  FULL: "Your gem bag cannot hold any more of those gems.",
};

let gems = null;

function gemIds() {
  gems ??= [...Storage.idsOf(Storage.DATA.gems)];
  return gems;
}

const family = {
  key: "gem-bag",
  names: NAMES,
  pairs: [["gem_bag", "gem_bag_open"]],
  openNames: ["Open gem bag"],
  accepts: (id) => gemIds().includes(id),
  room: (_player, id, held) => PER_GEM - (held.find((entry) => entry.id === id)?.amount ?? 0),
  gathers: (player) => Storage.hasOpen(player, family),
  gathered: (player) => player.sendMessage(STRAIGHT_IN),
  bankEmpty: emptyToBank,
};

function fill({ player }) {
  const held = Storage.inventoryIds(player).filter(family.accepts);
  if (!held.length) {
    player.sendMessage(MESSAGE.NO_GEMS);
    return;
  }
  const moved = held.reduce((sum, id) => sum + Storage.fillFrom(player, family, id), 0);
  player.sendMessage(moved > 0 ? FILLED : MESSAGE.FULL);
}

/** Ours (not captured): one line per gem, in the bag's own order. */
function check({ player }) {
  if (Storage.total(player, family) === 0) {
    player.sendMessage(MESSAGE.EMPTY);
    return;
  }
  const counts = gemIds().map((id) => `${Storage.itemName(id).replace(/^Uncut /, "")}: ${Storage.amountOf(player, family, id)}`);
  player.sendMessage(counts.join(" / "));
}

/** Wiki: Empty moves every gem to the inventory at once, sapphires first; with the bank open, into the bank. */
function empty({ player }) {
  if (Storage.core.Bank.isOpen(player)) return emptyToBank(player);
  if (Storage.total(player, family) === 0) {
    player.sendMessage(MESSAGE.EMPTY);
    return;
  }
  const ordered = gemIds().map((id) => ({ id, amount: Storage.amountOf(player, family, id) })).filter((entry) => entry.amount > 0);
  Storage.setContents(player, family, ordered);
  Storage.emptyToInventory(player, family);
}

function emptyToBank(player) {
  if (Storage.total(player, family) === 0) {
    player.sendMessage(MESSAGE.EMPTY);
    return;
  }
  Storage.emptyToBank(player, family);
}

function toggle({ player, item }) {
  Storage.toggle(player, family, item);
}

function useOnBag(event) {
  const { player, usedItem, usedWithItem } = event;
  const bag = NAMES.includes(Storage.nameOf(usedItem)) ? usedItem : NAMES.includes(Storage.nameOf(usedWithItem)) ? usedWithItem : null;
  const other = bag === usedItem ? usedWithItem : usedItem;
  if (!bag || !family.accepts(other?.getId?.())) return;
  event.handled = true;
  fill({ player });
}

/** Wiki: a gem picked up while the bag is open goes straight in. */
function pickup(event) {
  const { player, groundItem } = event;
  const item = groundItem.getItem();
  if (!Storage.hasOpen(player, family) || !family.accepts(item.getId())) return;
  // Uncut gems don't stack, so a pickup is one gem: it goes in whole or not at all.
  if (family.room(player, item.getId(), Storage.contents(player, family)) < item.getAmount()) return;
  Storage.store(player, family, item.getId(), item.getAmount());
  Storage.core.ItemOnGroundManager.deregister(groundItem);
  player.getLastItemPickup().reset();
  player.sendMessage(STRAIGHT_IN);
  event.handled = true;
}

module.exports = (api) => {
  Storage.register(family);
  for (const name of NAMES) {
    api.onItemAction(name, { Fill: fill, Open: toggle, Close: toggle, Check: check, Empty: empty });
  }
  api.onItemOnItem(useOnBag);
  api.onGroundItemPickup(pickup);
};

Object.assign(module.exports, { NAMES, PER_GEM, FILLED, STRAIGHT_IN, MESSAGE });
