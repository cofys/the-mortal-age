/**
 * Mining feeds the realm's metal economy, for real.
 *
 * Three wires out of the shafts, all through documented custom events - this
 * module never touches economy or kingdom internals:
 *
 *   1. Ore smelted is ore gone. Every bar smelted (smelting:success carries the
 *      bar) emits "economy:item-sink" (industry, "smelted") for each ingredient
 *      ore - a steel bar ate iron and coal the world must replace. The
 *      reference-price feed feels real consumption, and miners feel it in
 *      their coin pouches.
 *   2. The Rich Vein feeds the war effort directly: every load mined on a vein
 *      emits "kingdom:supply-donated" (ore) for the vein's kingdom, and the
 *      kingdom sim grows the quartermaster's stockpile from real picks.
 *   3. When a buyer posts bulk "economy:demand" for ore (a quartermaster
 *      stocking the armory, a smith, anyone), miners hear about it: citizens
 *      spread the word, so the demand board reaches the shafts instead of
 *      sitting unread. (War demands themselves are answered by Hazards'
 *      wartime quotas and the rich vein, and announced by the realm sim.)
 */
const { EVENTS } = require("../../economy/constants");
const { spreadRumor } = require("./Rumors.Mining");

const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  misthalin: "Misthalin",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

// Bulk demand at or above this much ore is worth spreading word about.
const BULK_DEMAND = 100;

let api = null;
let core = null;
// barId -> [[oreId, qty], ...], mirroring Smithing.plugin's SMELTING_RECIPES.
let ingredientsByBarId = new Map();
let oreIds = new Set();

function itemName(itemId) {
  try {
    return core.ItemDefinition.forId(itemId).getName() ?? "ore";
  } catch (error) {
    return "ore";
  }
}

/** A bar left the furnace: every ingredient ore left the world with it. */
function onSmelted(event) {
  const barId = event?.itemId == null ? null : Math.floor(event.itemId);
  const ingredients = barId == null ? null : ingredientsByBarId.get(barId);
  if (!ingredients) return;
  for (const [oreId, qty] of ingredients) {
    api.emitCustomEvent(EVENTS.ITEM_SINK, {
      itemId: oreId,
      amount: qty,
      sink: "industry",
      reason: "smelted",
    });
  }
}

/** Rich-vein loads go straight to the war effort. */
function onMined(event) {
  if (!event?.vein || !event?.mine) return;
  api.emitCustomEvent("kingdom:supply-donated", {
    kingdomId: event.mine.kingdom,
    kind: "ore",
    amount: 1 + (event.bonusOre ?? 0),
    itemId: event.oreId,
  });
}

/** Bulk ore demand: make sure the shafts hear about it. */
function onDemand(event) {
  const items = Array.isArray(event?.items) ? event.items : [];
  const wanted = items.filter(
    (item) => item && oreIds.has(Math.floor(item.itemId)) && (item.amount ?? 0) >= BULK_DEMAND,
  );
  if (wanted.length === 0) return;
  const kingdomId = event.kingdomId ?? "asgarnia";
  const kingdom = KINGDOM_NAMES[kingdomId] ?? event.source ?? "a kingdom";
  const names = [...new Set(wanted.map((item) => itemName(Math.floor(item.itemId))))].slice(0, 3);
  spreadRumor(
    api, kingdomId,
    `${kingdom} is buying ${names.join(", ")} in bulk - ore prices are climbing!`,
  );
}

function buildOreTables() {
  const I = core.ItemIdentifiers;
  const bars = [
    ["BRONZE_BAR", [["COPPER_ORE", 1], ["TIN_ORE", 1]]],
    ["IRON_BAR", [["IRON_ORE", 1]]],
    ["SILVER_BAR", [["SILVER_ORE", 1]]],
    ["STEEL_BAR", [["IRON_ORE", 1], ["COAL", 2]]],
    ["GOLD_BAR", [["GOLD_ORE", 1]]],
    ["MITHRIL_BAR", [["MITHRIL_ORE", 1], ["COAL", 4]]],
    ["ADAMANTITE_BAR", [["ADAMANTITE_ORE", 1], ["COAL", 6]]],
    ["RUNITE_BAR", [["RUNITE_ORE", 1], ["COAL", 8]]],
  ];
  ingredientsByBarId = new Map();
  oreIds = new Set();
  for (const [barName, ingredients] of bars) {
    if (I[barName] == null) continue;
    const resolved = [];
    for (const [oreName, qty] of ingredients) {
      if (I[oreName] == null) continue;
      resolved.push([I[oreName], qty]);
      oreIds.add(I[oreName]);
    }
    if (resolved.length > 0) ingredientsByBarId.set(I[barName], resolved);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  buildOreTables();
  api.onCustomEvent("smelting:success", onSmelted);
  api.onCustomEvent("mining:success", onMined);
  api.onCustomEvent(EVENTS.DEMAND, onDemand);
  api.log("registered", { trackedBars: ingredientsByBarId.size, trackedOres: oreIds.size });
}

module.exports = { attach, onSmelted, onMined, onDemand, itemName, BULK_DEMAND };
