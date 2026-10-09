// Port coin bags (Wiki): a finished courier task's usual reward, coins by size. Port reward bags
// (one set per destination port) hold port-specific loot from the Wiki's tables, not done yet.
const common = require("./Common.PortTasks");

/** Coins by bag size, tiny to huge (Wiki, Port coin bag). */
const COINS = [[800, 1200], [1613, 2714], [2486, 3595], [3864, 5350], [6400, 9600]];
const SIZES = ["Tiny", "Small", "Medium", "Large", "Huge"];

function openCoinBag({ player, itemId }) {
  const size = common.DATA.coinBags.indexOf(itemId);
  if (size < 0 || !player.getInventory().contains(itemId)) return false;
  const [min, max] = COINS[size];
  const coins = min + Math.floor(Math.random() * (max - min + 1));
  const { Item, ItemIdentifiers } = common.core();
  player.getInventory().deleteNumber(itemId, 1);
  player.getInventory().addItem(new Item(ItemIdentifiers.COINS, coins));
  player.sendMessage(`You open the bag and find ${coins.toLocaleString("en-GB")} coins.`);
  return true;
}

function openRewardBag({ player }) {
  player.sendMessage("Port reward bags can't be opened yet.");
  return true;
}

function attach(api) {
  common.init(api);
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
