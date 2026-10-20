"use strict";

const { api, Animation, CountdownTask, ItemIdentifiers, TaskManager } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const House = require("./House.Construction");
const KITCHEN = require("./data/kitchen.json");

// rsprox captures: filling a glass plays poh_barrel_use1, then the barrel's pour animation with
// the glass changing two ticks later.
const BARREL_USE = Ids.seq("poh_barrel_use1");
const MENU_SIZE = 5;

function kitchenFurniture(event) {
  const house = House.houseFor(event.player);
  return house?.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10) ?? null;
}

/** "Select an option" over `items` ([label, itemId]), four at a time with More... (captures). */
function offer(player, items) {
  const page = items.length <= MENU_SIZE ? items : items.slice(0, MENU_SIZE - 1);
  const rest = items.slice(page.length);
  const options = page.flatMap(([label, itemId]) => [label, () => take(player, itemId)]);
  if (rest.length) options.push("More...", () => offer(player, rest));
  api.sendMultiChatboxPrompt(player, "Select an option", ...options);
}

function take(player, itemId) {
  if (!House.houseFor(player)) return;
  if (player.getInventory().getFreeSlots() === 0 && !player.getInventory().contains(itemId)) {
    player.sendMessage("You don't have enough inventory space.");
    return;
  }
  player.getInventory().adds(itemId, 1);
}

function search(event) {
  const furniture = kitchenFurniture(event);
  const items = furniture && (KITCHEN.larders[furniture.buildableKey] ?? KITCHEN.shelves[furniture.buildableKey]);
  if (!items) return false;
  offer(event.player, items);
  return true;
}

function fillGlass(event) {
  const furniture = kitchenFurniture(event);
  const barrel = furniture && KITCHEN.barrels[furniture.buildableKey];
  if (!barrel) return false;
  const [drink, name, pour] = barrel;
  const player = event.player;
  player.performAnimation(new Animation(BARREL_USE));
  TaskManager.submit(new CountdownTask(player, 2, () => {
    if (!player.getInventory().contains(ItemIdentifiers.BEER_GLASS)) return;
    player.performAnimation(new Animation(pour));
    player.getInventory().delete(ItemIdentifiers.BEER_GLASS, 1);
    player.getInventory().adds(drink, 1);
    player.sendMessage(`You fill the glass with ${name}.`);
  }));
  return true;
}

function attachKitchen(api) {
  api.onObjectInteraction("Larder", { Search: search });
  api.onObjectInteraction("Shelves", { Search: search });
  api.onItemOnObject(useOnBarrel, { noted: false });
}

function useOnBarrel(event) {
  if (event.itemId === ItemIdentifiers.BEER_GLASS && fillGlass(event)) event.handled = true;
}

Object.assign(module.exports, { attachKitchen });
