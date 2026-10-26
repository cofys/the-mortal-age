/**
 * What every container shares (docs/storage-items.md): the `storage:*` events gatherers and
 * consumers emit, the bank panel's op9 and its Fill label (the container's param-595 op: "Empty", or "Use" for the
 * tackle box; captured on the herb sack and seed box, which move everything into the bank
 * silently), death, and Destroy.
 */
const Storage = require("./Common.StorageItems");

/** The bank panel's op that the cache labels with param 595. */
const BANK_OP = 9;

/**
 * `if4` (varp 264): one bit per inventory slot whose bank op the cache's script 2576 labels "Fill"
 * instead of its param-595 text (Wiki, Plank sack: since 27 August 2025 the op reads Fill or Empty
 * by whether the inventory has anything it takes).
 */
const BANK_FILL_VARP = 264;

function bankRefreshed({ player }) {
  let bits = 0;
  player.getInventory().getItems().forEach((item, slot) => {
    if (Storage.familyOf(item)?.bankFills?.(player)) bits |= 1 << slot;
  });
  const sender = player.getPacketSender();
  if (sender.getVarp(BANK_FILL_VARP) !== bits) sender.sendConfig(BANK_FILL_VARP, bits);
}

function bankOp(event) {
  if (event.op !== BANK_OP) return;
  const family = Storage.familyOf(event.item);
  if (!family?.bankEmpty) return;
  family.bankEmpty(event.player);
  event.handled = true;
}

/**
 * A family whose contents follow its item (fish barrel, tackle box): when the last one carried
 * heads for the floor, so do its contents. One that is kept keeps them.
 */
function deathDrops(event) {
  for (const family of Storage.FAMILIES.values()) {
    if (!family.followsOnDeath) continue;
    const isOurs = (item) => family.names.includes(Storage.nameOf(item));
    if (!event.items.some(isOurs) || event.untradeables.some(isOurs)) continue;
    for (const { id, amount } of Storage.contents(event.player, family)) event.items.push(new Storage.core.Item(id, amount));
    Storage.setContents(event.player, family, []);
  }
}

module.exports = (api) => {
  api.onCustomEvent("storage:contents", Storage.answerContents);
  api.onCustomEvent(Storage.ROOM_EVENT, Storage.answerRoom);
  api.onCustomEvent(Storage.GATHER_EVENT, Storage.answerGather);
  api.onCustomEvent(Storage.AMOUNT_EVENT, Storage.answerAmount);
  api.onCustomEvent(Storage.TAKE_EVENT, Storage.answerTake);
  api.onCustomEvent(Storage.core.Bank.INVENTORY_OP_EVENT, bankOp);
  api.onCustomEvent(Storage.core.Bank.REFRESHED_EVENT, bankRefreshed);
  api.onCustomEvent("destroy-item:destroyed", Storage.destroyed);
  api.onPlayerDeathDrops(deathDrops);
};

/** For a death-drops hook that takes the lost items before this one runs (a boss's deathbank). */
module.exports.deathDrops = deathDrops;
