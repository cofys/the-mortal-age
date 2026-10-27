/**
 * Tai Bwo Wannai Cleanup: skewer sticks and spiders on sticks (rsprox 227/01858). A machete on a
 * thatching spar hacks it into 5 skewer sticks ("You hack the spar into skewers.", the
 * prepare-wood animation and sound); a skewer stick on a spider carcass makes a raw spider on stick.
 */
const Common = require("./Common.TaiBwoWannaiCleanup");

function isSpar(id) {
  return Common.data.spars.some((spar) => Common.objId(spar.item) === id);
}

function isMachete(id) {
  return Common.data.machetes.some((machete) => Common.objId(machete.item) === id);
}

function hackSpar(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const spar = isSpar(usedItemId) ? usedItemId : usedWithItemId;
  if (!isSpar(spar) || !isMachete(spar === usedItemId ? usedWithItemId : usedItemId)) return false;
  event.handled = true;
  const inventory = player.getInventory();
  inventory.delete(spar, 1);
  inventory.add(new Common.core.Item(Common.objId(Common.data.skewers.item), Common.data.skewers.perSpar));
  Common.animate(player, "prepare", 30);
  Common.sound(player, Common.data.sounds.prepare, 30);
  Common.spam(player, Common.message("skewers"));
  return true;
}

function skewerSpider(event) {
  const { player } = event;
  event.handled = true;
  const { skewers } = Common.data;
  const inventory = player.getInventory();
  inventory.delete(Common.objId(skewers.item), 1);
  inventory.delete(Common.objId(skewers.carcass), 1);
  inventory.add(new Common.core.Item(Common.objId(skewers.spiderOnStick), 1));
  Common.animate(player, "spiderOnStick");
  Common.sound(player, Common.data.sounds.spiderOnStick);
  return true;
}

function attachSkewers(api) {
  const name = (obj) => Common.core.CacheDefinitions.getItem(Common.objId(obj)).name;
  for (const spar of Common.data.spars) {
    for (const machete of Common.data.machetes) api.onItemOnItem(name(machete.item), name(spar.item), hackSpar);
  }
  api.onItemOnItem(name(Common.data.skewers.item), name(Common.data.skewers.carcass), skewerSpider);
}

module.exports = { attachSkewers, hackSpar, skewerSpider };
