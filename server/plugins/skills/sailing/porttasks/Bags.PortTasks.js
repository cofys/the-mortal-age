// Port coin bags and reward bags. Wiki loot and source limits: docs/port-tasks.md.
const common = require("./Common.PortTasks");
const loot = require("./Loot.PortTasks");
// A blocked opening keeps its roll through bank transfers/logout, rather than rerolling.
const PENDING_ATTRIBUTE = "port-tasks:pending-bag-rewards";

/** Coins by bag size, tiny to huge (Wiki, Port coin bag). */
const COINS = [[800, 1200], [1600, 2400], [2400, 3600], [3600, 5400], [6400, 9600]];
const SIZES = ["Tiny", "Small", "Medium", "Large", "Huge"];
const PENDING_COIN_ATTRIBUTE = "port-tasks:pending-coin-bags";

function openCoinBag({ player, itemId, item, slot, interfaceId }) {
  const size = common.DATA.coinBags.indexOf(itemId);
  if (size < 0) return false;
  const { CacheDefinitions, Inventory, Item, ItemIdentifiers } = common.core();
  const inventory = player.getInventory();
  if (interfaceId !== Inventory.INTERFACE_ID && interfaceId !== CacheDefinitions.getComponentId("inventory:items")) return false;
  if (inventory.getItems()[slot] !== item || item.getId() !== itemId || item.getAmount() < 1 || player.busy()) return true;
  const [min, max] = COINS[size];
  const pending = { ...(player.getAttribute(PENDING_COIN_ATTRIBUTE) ?? {}) };
  const stored = pending[itemId];
  const coins = Number.isSafeInteger(stored) && stored >= min && stored <= max
    ? stored : min + Math.floor(Math.random() * (max - min + 1));
  const payout = new Item(ItemIdentifiers.COINS, coins);
  // The last bag may free a slot. Use the real container's metadata and stack-cap
  // rules before changing any live item, then consume only the clicked slot.
  const planned = new Inventory(player).setItems(inventory.getCopiedItems());
  planned.deleteAtSlot(slot, 1, false);
  if (planned.getAddableAmount(payout) !== coins) {
    pending[itemId] = coins;
    player.setAttribute(PENDING_COIN_ATTRIBUTE, pending);
    inventory.full();
    return true;
  }
  inventory.deleteAtSlot(slot, 1, false);
  inventory.add(payout, false);
  inventory.refreshItems();
  delete pending[itemId];
  player.setAttribute(PENDING_COIN_ATTRIBUTE, pending);
  player.sendMessage(`You open the bag and find ${coins.toLocaleString("en-GB")} coins.`);
  return true;
}

function openRewardBag({ player, itemId, item, slot, interfaceId }) {
  const { CacheDefinitions, Inventory, Item } = common.core();
  const inventory = player.getInventory();
  if (interfaceId !== Inventory.INTERFACE_ID && interfaceId !== CacheDefinitions.getComponentId("inventory:items")) return false;
  if (inventory.getItems()[slot] !== item || item.getId() !== itemId || item.getAmount() < 1 || player.busy()) return true;
  const table = loot.tableFor(itemId);
  if (!table) {
    // The cache includes size/port combinations that cannot be awarded in OSRS.
    player.sendMessage("This reward bag has no supported loot table.");
    return true;
  }
  const pending = { ...(player.getAttribute(PENDING_ATTRIBUTE) ?? {}) };
  const reward = loot.valid(table, pending[itemId]) ? pending[itemId] : loot.roll(table);
  const rewardId = CacheDefinitions.getObjId(reward.item);
  if (rewardId == null) return true;
  const output = new Item(rewardId, reward.amount);
  // Use the real container's metadata/stack-cap rules with the clicked bag removed.
  // Do not mutate the live inventory until the entire drop fits.
  const planned = new Inventory(player).setItems(inventory.getCopiedItems());
  planned.deleteAtSlot(slot, 1, false);
  if (planned.getAddableAmount(output) < output.getAmount()) {
    pending[itemId] = reward;
    player.setAttribute(PENDING_ATTRIBUTE, pending);
    inventory.full();
    return true;
  }
  inventory.deleteAtSlot(slot, 1, false);
  inventory.add(output, false);
  inventory.refreshItems();
  delete pending[itemId];
  player.setAttribute(PENDING_ATTRIBUTE, pending);
  player.sendMessage(`You open the bag and find ${reward.amount.toLocaleString("en-GB")} x ${CacheDefinitions.getItem(rewardId).name}.`);
  return true;
}

function attach(api) {
  common.init(api);
  api.persistAttribute(PENDING_ATTRIBUTE, {});
  api.persistAttribute(PENDING_COIN_ATTRIBUTE, {});
  for (const size of SIZES) {
    api.onItemAction(`${size} port coin bag`, { Open: openCoinBag });
    for (const port of rewardBagPorts()) api.onItemAction(`${size} port reward bag (${port})`, { Open: openRewardBag });
  }
}

/** The ports in the reward bags' names, from the cache (as port-tasks.json lists them). */
function rewardBagPorts() {
  const names = new Set();
  for (const ids of Object.values(common.DATA.rewardBags)) {
    for (const id of ids) {
      const name = id && common.core().CacheDefinitions.getItem(id)?.name;
      const port = name && /\((.+)\)$/.exec(name)?.[1];
      if (port) names.add(port);
    }
  }
  return names;
}

module.exports = attach;
module.exports.COINS = COINS;
module.exports.PENDING_ATTRIBUTE = PENDING_ATTRIBUTE;
module.exports.PENDING_COIN_ATTRIBUTE = PENDING_COIN_ATTRIBUTE;
