/**
 * Fish barrel and fish sack barrel (https://oldschool.runescape.wiki/w/Fish_barrel;
 * docs/storage-items.md): 28 raw fish of any kind between them. Open, it takes the fish a
 * player catches. It has no inventory Empty: it empties at a bank. On death the fish go where
 * the barrel goes.
 */
const Storage = require("./Common.StorageItems");

const BARREL = ["Fish barrel", "Open fish barrel"];
const SACK_BARREL = ["Fish sack barrel", "Open fish sack barrel"];
const CAPACITY = 28;
/** Wiki: shown when the barrel fills up. */
const FULL = "The barrel is full. It may be emptied at a bank.";
const MESSAGE = {
  /** Client plugins parse this line. */
  EMPTY: "The barrel is empty.",
  /** Ours (not captured). */
  NO_FISH: "You have no raw fish to put in the barrel.",
};

let fish = null;

function fishIds() {
  fish ??= new Set([...Storage.idsOf(Storage.DATA.fish)].filter((id) => !Storage.isStackable(id)));
  return fish;
}

const family = {
  key: "fish-barrel",
  names: [...BARREL, ...SACK_BARREL],
  pairs: [["fish_barrel_closed", "fish_barrel_open"], ["fish_sack_barrel_closed", "fish_sack_barrel_open"]],
  openNames: [BARREL[1], SACK_BARREL[1]],
  worn: true,
  followsOnDeath: true,
  accepts: (id) => fishIds().has(id),
  room: (_player, _id, held) => CAPACITY - held.reduce((sum, entry) => sum + entry.amount, 0),
  gathers: (player) => Storage.hasOpen(player, family),
  gathered: (player) => {
    if (Storage.total(player, family) >= CAPACITY) player.sendMessage(FULL);
  },
  bankEmpty: emptyToBank,
};

function fill({ player }) {
  if (Storage.total(player, family) >= CAPACITY) {
    player.sendMessage(FULL);
    return;
  }
  const held = Storage.inventoryIds(player).filter(family.accepts);
  if (!held.length) {
    player.sendMessage(MESSAGE.NO_FISH);
    return;
  }
  for (const id of held) Storage.fillFrom(player, family, id);
  if (Storage.total(player, family) >= CAPACITY) player.sendMessage(FULL);
}

/** The Check box lists "N x Raw fish" per kind (client plugins read it), like the log basket's. */
function check({ player }) {
  const held = Storage.contents(player, family);
  if (!held.length) {
    player.sendMessage(MESSAGE.EMPTY);
    return;
  }
  Storage.showBox(player, ["The barrel contains:", Storage.describe(held).join(", ")]);
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

function useOnBarrel(event) {
  const { player, usedItem, usedWithItem } = event;
  const barrel = family.names.includes(Storage.nameOf(usedItem)) ? usedItem : family.names.includes(Storage.nameOf(usedWithItem)) ? usedWithItem : null;
  const other = barrel === usedItem ? usedWithItem : usedItem;
  if (!barrel || !family.accepts(other?.getId?.())) return;
  event.handled = true;
  fill({ player });
}

module.exports = (api) => {
  Storage.register(family);
  for (const name of family.names) api.onItemAction(name, { Fill: fill, Check: check, Open: toggle, Close: toggle });
  api.onItemOnItem(useOnBarrel);
};

Object.assign(module.exports, { CAPACITY, FULL, MESSAGE });
