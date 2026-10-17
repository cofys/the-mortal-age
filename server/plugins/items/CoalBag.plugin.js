/**
 * The coal bag (https://oldschool.runescape.wiki/w/Coal_bag): holds 27 coal, or 36 while a
 * Smithing cape (or max cape) is worn. Fill takes the coal carried; Empty puts as much back as
 * there is room for; Check says how much it holds. Open swaps it for the open coal bag, which
 * catches coal as it is mined ("mining:ore" asks), and Close swaps it back. Coal used on the bag
 * fills it too. Its feedback is chat messages, as the Wiki says it has been since 2024; the
 * wording has no capture.
 */
const COAL_ATTRIBUTE = "coal-bag:coal";
const CAPACITY = 27;
const CAPE_CAPACITY = 36;

let api;
let core;
const IDS = {};

function stored(player) {
  return Number(player.getAttribute(COAL_ATTRIBUTE)) || 0;
}

function capacity(player) {
  const request = { player, skill: "SMITHING", result: false };
  api.emitCustomEvent("skillcape:has-perk", request);
  return request.result === true ? CAPE_CAPACITY : CAPACITY;
}

function pieces(amount) {
  return amount === 1 ? "one piece of coal" : `${amount} pieces of coal`;
}

function check(player) {
  const amount = stored(player);
  player.sendMessage(amount === 0 ? "The coal bag is empty." : `The coal bag contains ${pieces(amount)}.`);
}

function fill(player) {
  const inventory = player.getInventory();
  const room = capacity(player) - stored(player);
  if (room <= 0) {
    player.sendMessage("The coal bag can't hold any more coal.");
    return;
  }
  const moved = Math.min(room, inventory.getAmount(IDS.coal));
  if (moved === 0) {
    player.sendMessage("You don't have any coal to put in the bag.");
    return;
  }
  inventory.deleteNumber(IDS.coal, moved);
  player.setAttribute(COAL_ATTRIBUTE, stored(player) + moved);
  check(player);
}

function empty(player) {
  const amount = stored(player);
  if (amount === 0) {
    check(player);
    return;
  }
  const moved = Math.min(amount, player.getInventory().getFreeSlots());
  if (moved === 0) {
    player.getInventory().full();
    return;
  }
  player.getInventory().adds(IDS.coal, moved);
  player.setAttribute(COAL_ATTRIBUTE, amount - moved);
  check(player);
}

function swap(event, to) {
  event.player.getInventory().getItems()[event.slot]?.setId?.(to);
  event.player.getInventory().refreshItems();
}

const ACTIONS = {
  Fill: ({ player }) => fill(player),
  Check: ({ player }) => check(player),
  Empty: ({ player }) => empty(player),
  Open: (event) => swap(event, IDS.open),
  Close: (event) => swap(event, IDS.closed),
};

function coalOnBag(event) {
  const ids = [event.usedItemId, event.usedWithItemId];
  if (!ids.includes(IDS.coal) || !(ids.includes(IDS.closed) || ids.includes(IDS.open))) return;
  event.handled = true;
  fill(event.player);
}

/** "mining:ore" `{ player, oreId, banked }`: an open coal bag with room takes mined coal. */
function catchMinedCoal(request) {
  const { player } = request;
  if (request.banked || request.oreId !== IDS.coal || !player.getInventory().contains(IDS.open)) return;
  if (stored(player) >= capacity(player)) return;
  player.setAttribute(COAL_ATTRIBUTE, stored(player) + 1);
  request.banked = true;
}

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  Object.assign(IDS, {
    coal: core.CacheDefinitions.getObjId("coal"),
    closed: core.CacheDefinitions.getObjId("coal_bag"),
    open: core.CacheDefinitions.getObjId("coal_bag_open"),
  });
}

module.exports = {
  name: "CoalBag",
  members: true,
  _test: { fill, empty, check, capacity, catchMinedCoal, IDS, COAL_ATTRIBUTE },
  register(pluginApi) {
    init(pluginApi);
    api.persistAttribute(COAL_ATTRIBUTE, 0);
    api.onItemAction("Coal bag", ACTIONS);
    api.onItemAction("Open coal bag", ACTIONS);
    api.onItemOnItem(coalOnBag);
    api.onCustomEvent("mining:ore", catchMinedCoal);
  },
};
