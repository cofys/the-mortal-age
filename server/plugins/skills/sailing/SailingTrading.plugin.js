// Coastal trading: the level-10 Sailing XP loop. Buy sealed trade crates from a port master,
// sail them to another port and sell them there; the price grows with the voyage's distance,
// and so does the Sailing XP. One voyage at a time, up to eight crates a hold.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { content, dockNear } = require("./SailingContent.Sailing");
const { currentWind, windXpFactor } = require("./SailingWind.plugin");

const TRADE_VOYAGE_ATTRIBUTE = "sailing:trade-voyage";
const TRADE_CRATE = 50005;
const COINS = 995;
/** The level that unlocks coastal trading. */
const TRADE_LEVEL = 10;
/** Crates a single voyage tracks (inventory space is the real cap). */
const MAX_CRATES = 8;
/** Sell price grows this much per tile sailed from the buying port. */
const PRICE_PER_TILE = 1 / 1500;
/** Sailing XP per tile per crate on a completed voyage. */
const XP_PER_TILE_CRATE = 5;

let pluginApi = null;

function voyageOf(player) {
  return player.getAttribute(TRADE_VOYAGE_ATTRIBUTE);
}

function setVoyage(player, voyage) {
  player.setAttribute(TRADE_VOYAGE_ATTRIBUTE, voyage ?? null);
}

function cratesHeld(player) {
  return player.getInventory().getAmount(TRADE_CRATE);
}

/** The dock whose port master the player is talking to, if any. */
function dockHere(player) {
  return dockNear(player, 60);
}

/** One crate's price at a port: richer ports pay more for goods. */
function cratePrice(dock) {
  return 50 + 10 * (dock?.level ?? 1);
}

function sailingLevel(player) {
  return player.getSkillManager().getMaxLevel(Skill.SAILING);
}

function payFromInventory(player, amount) {
  const inventory = player.getInventory();
  if (inventory.getAmount(COINS) < amount) return false;
  inventory.delete(COINS, amount);
  return true;
}

/** A port master's Buy-trade-goods: one sealed crate, priced by the port. */
function buyTradeGoods({ player }) {
  const dock = dockHere(player);
  if (!dock) return;
  if (sailingLevel(player) < TRADE_LEVEL) {
    player.sendMessage(`You need a Sailing level of ${TRADE_LEVEL} to trade goods between ports.`);
    return;
  }
  const price = cratePrice(dock);
  if (!payFromInventory(player, price)) {
    player.sendMessage(`You need ${price} coins to buy a sealed trade crate here.`);
    return;
  }
  const voyage = voyageOf(player);
  if (voyage && voyage.origin !== dock.id) {
    player.sendMessage("You already hold goods bound from another port — sell those first.");
    player.getInventory().addItem(new Item(COINS, price));
    return;
  }
  if (voyage && voyage.crates >= MAX_CRATES) {
    player.sendMessage(`Your hold only tracks ${MAX_CRATES} crates a voyage.`);
    player.getInventory().addItem(new Item(COINS, price));
    return;
  }
  player.getInventory().addItem(new Item(TRADE_CRATE, 1));
  setVoyage(player, {
    origin: dock.id,
    crates: (voyage?.crates ?? 0) + 1,
    cost: (voyage?.cost ?? 0) + price,
  });
  player.sendMessage(`You buy a sealed trade crate for ${price} coins. Sell it at a distant port for a profit.`);
}

function tilesBetween(a, b) {
  return Math.hypot(a.buoy.x - b.buoy.x, a.buoy.y - b.buoy.y);
}

/** A port master's Sell-trade-goods: sells the voyage's crates at this port's price. */
function sellTradeGoods({ player }) {
  const dock = dockHere(player);
  const voyage = dock && voyageOf(player);
  if (!voyage || voyage.origin === dock.id || cratesHeld(player) === 0) {
    player.sendMessage("You have no trade goods bound for this port.");
    return;
  }
  const origin = content().docks.find((candidate) => candidate.id === voyage.origin);
  if (!origin?.buoy || !dock.buoy) {
    player.sendMessage("Your trade ledgers don't add up; the voyage is cancelled.");
    setVoyage(player, null);
    return;
  }
  const distance = tilesBetween(origin, dock);
  const crates = Math.min(cratesHeld(player), voyage.crates, MAX_CRATES);
  const unitCost = voyage.cost / Math.max(1, voyage.crates);
  const unitPrice = Math.round(unitCost * (1 + distance * PRICE_PER_TILE));
  const proceeds = unitPrice * crates;
  const profit = proceeds - Math.round(unitCost * crates);
  player.getInventory().delete(TRADE_CRATE, crates);
  player.getInventory().addItem(new Item(COINS, proceeds));
  const boat = Sailing.instanceAboard(player);
  const bonus = boat ? windXpFactor(boat.heading, currentWind()) : 1;
  const xp = Math.round(distance * XP_PER_TILE_CRATE * crates * bonus);
  if (xp > 0) player.getSkillManager().addExperience(Skill.SAILING, xp, true);
  setVoyage(player, null);
  player.sendMessage(profit >= 0
    ? `You sell ${crates} trade crates for ${proceeds} coins (${profit} profit) and earn Sailing XP for the voyage.`
    : `You sell ${crates} trade crates for ${proceeds} coins.`);
}

/** Quotes the current voyage, for tests and future UI. */
function voyageQuote(player, dock) {
  const voyage = voyageOf(player);
  if (!voyage) return undefined;
  const origin = content().docks.find((candidate) => candidate.id === voyage.origin);
  if (!origin?.buoy || !dock?.buoy || origin.id === dock.id) return undefined;
  const distance = tilesBetween(origin, dock);
  const unitCost = voyage.cost / Math.max(1, voyage.crates);
  return {
    distance: Math.round(distance),
    unitPrice: Math.round(unitCost * (1 + distance * PRICE_PER_TILE)),
    xp: Math.round(distance * XP_PER_TILE_CRATE * Math.min(voyage.crates, MAX_CRATES)),
  };
}

module.exports = {
  name: "SailingTrading",
  members: true,
  TRADE_VOYAGE_ATTRIBUTE,
  TRADE_CRATE,
  TRADE_LEVEL,
  MAX_CRATES,
  cratePrice,
  voyageQuote,
  register(api) {
    pluginApi = api;
    content();
    api.onNpcInteraction("Port master", {
      "Buy-trade-goods": buyTradeGoods,
      "Sell-trade-goods": sellTradeGoods,
    });
  },
};
