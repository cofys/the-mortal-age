// Charting: the level-35 Sailing XP loop. The ocean is divided into chart regions; sailing
// your own boat into a region you have never mapped charts it for one-time Sailing XP.
// Below 35 the XP is a trickle, from 35 a full surveyor's share. A port master buys your
// unsold charts, so mapping the far seas pays twice.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { content, dockNear } = require("./sailingContent");
const { currentWind, windXpFactor } = require("./SailingWind.plugin");

const CHARTED_ATTRIBUTE = "sailing:charted-regions";
const UNSOLD_ATTRIBUTE = "sailing:charts-unsold";
/** Tiles a side of one chart region. */
const REGION_TILES = 64;
/** The level that unlocks full charting XP. */
const CHART_LEVEL = 35;
/** One-time Sailing XP per new region, before and from the unlock. */
const XP_NEW_REGION = 120;
const XP_NEW_REGION_LOW = 20;
/** Coins a port master pays per unsold charted region. */
const PRICE_PER_REGION = 30;
const COINS = 995;

let pluginApi = null;
/** Per player: their charted regions as a Set (the attribute holds the persisted array). */
const charts = new Map();

function regionKey(x, y) {
  return `${Math.floor(x / REGION_TILES)},${Math.floor(y / REGION_TILES)}`;
}

function chartedOf(player) {
  let set = charts.get(player);
  if (!set) {
    set = new Set(player.getAttribute(CHARTED_ATTRIBUTE) ?? []);
    charts.set(player, set);
  }
  return set;
}

function markCharted(player, set) {
  player.setAttribute(CHARTED_ATTRIBUTE, [...set]);
  player.setAttribute(UNSOLD_ATTRIBUTE, (player.getAttribute(UNSOLD_ATTRIBUTE) ?? 0) + 1);
}

/** Charts the region under the boat, if the player hasn't mapped it. Returns XP or 0. */
function chartRegion(player, boat) {
  const key = regionKey(Math.floor(boat.fineX / 128), Math.floor(boat.fineY / 128));
  const set = chartedOf(player);
  if (set.has(key)) return 0;
  set.add(key);
  markCharted(player, set);
  const level = player.getSkillManager().getMaxLevel(Skill.SAILING);
  const base = level >= CHART_LEVEL ? XP_NEW_REGION : XP_NEW_REGION_LOW;
  const xp = Math.round(base * windXpFactor(boat.heading, currentWind()));
  player.getSkillManager().addExperience(Skill.SAILING, xp, true);
  player.sendMessage(level >= CHART_LEVEL
    ? `You chart these waters for the first time. (+${xp} Sailing XP)`
    : "You sail uncharted waters, sketching what you can.");
  return xp;
}

/** Each tick: everyone sailing their own boat charts the water under them. */
function tickCharting() {
  for (const player of World.getPlayers()) {
    const boat = player && Sailing.instanceAboard(player);
    if (!boat) continue;
    chartRegion(player, boat);
  }
}

/** A port master's Sell-charts: buys every chart the player hasn't sold yet. */
function sellCharts({ player }) {
  const dock = dockNear(player, 60);
  if (!dock) return;
  const unsold = player.getAttribute(UNSOLD_ATTRIBUTE) ?? 0;
  if (unsold <= 0) {
    player.sendMessage("You have no unsold charts. Sail somewhere new first.");
    return;
  }
  const payment = unsold * PRICE_PER_REGION;
  player.setAttribute(UNSOLD_ATTRIBUTE, 0);
  player.getInventory().addItem(new Item(COINS, payment));
  player.sendMessage(`The port master buys your ${unsold} unsold charts for ${payment} coins.`);
}

function forgetCharts({ player }) {
  charts.delete(player);
}

module.exports = {
  name: "SailingCharting",
  members: true,
  CHARTED_ATTRIBUTE,
  UNSOLD_ATTRIBUTE,
  REGION_TILES,
  CHART_LEVEL,
  XP_NEW_REGION,
  regionKey,
  chartRegion,
  register(api) {
    pluginApi = api;
    content();
    api.onNpcInteraction("Port master", { "Sell-charts": sellCharts });
    api.onPlayerLogout(forgetCharts);
    BoatManager.onAfterTick(tickCharting);
  },
};
