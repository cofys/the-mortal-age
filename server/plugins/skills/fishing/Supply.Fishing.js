/**
 * Fishing feeds the citizen food economy, for real.
 *
 * Two wires into the economy plugin (server/plugins/economy/), both through its
 * documented custom events - this module never touches economy internals:
 *
 *   1. Fish eaten is fish gone. Every cooked fish (and every burnt one) emits
 *      "economy:item-sink" for the raw fish, so the reference-price feed feels
 *      actual consumption: guards eating, citizens' meal breaks, war rations.
 *      When the world eats faster than anglers catch, fish prices climb - and
 *      fishermen feel it in their coin pouches.
 *   2. When a buyer posts bulk "economy:demand" for fish (a quartermaster
 *      stocking war rations, a master cook, anyone), anglers hear about it:
 *      citizens spread the word, so the demand board reaches the docks instead
 *      of sitting unread.
 */
const { EVENTS } = require("../../economy/constants");
const { spreadRumor } = require("./Rumors.Fishing");

const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  misthalin: "Misthalin",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

// Bulk demand at or above this many fish is worth spreading word about.
const BULK_DEMAND = 100;

let api = null;
let core = null;
let cookedToRaw = new Map();
let rawFishIds = new Set();
let fishIds = new Set();

function itemName(itemId) {
  try {
    return core.ItemDefinition.forId(itemId).getName() ?? "fish";
  } catch (error) {
    return "fish";
  }
}

/** A cooked (or burnt) fish left the world: record the consumption sink. */
function onCooked(event) {
  const rawId = cookedToRaw.get(event.itemId);
  if (rawId == null) return;
  api.emitCustomEvent(EVENTS.ITEM_SINK, {
    itemId: rawId,
    amount: 1,
    sink: "consumables",
    reason: "cooked",
  });
}

function onBurnt(event) {
  if (!rawFishIds.has(event.rawId)) return;
  api.emitCustomEvent(EVENTS.ITEM_SINK, {
    itemId: event.rawId,
    amount: 1,
    sink: "consumables",
    reason: "burnt",
  });
}

/** Bulk fish demand: make sure the docks hear about it. */
function onDemand(event) {
  const items = Array.isArray(event?.items) ? event.items : [];
  const wanted = items.filter(
    (item) => item && fishIds.has(Math.floor(item.itemId)) && (item.amount ?? 0) >= BULK_DEMAND,
  );
  if (wanted.length === 0) return;
  const kingdomId = event.kingdomId ?? "misthalin";
  const kingdom = KINGDOM_NAMES[kingdomId] ?? event.source ?? "a kingdom";
  const names = [...new Set(wanted.map((item) => itemName(Math.floor(item.itemId))))].slice(0, 3);
  spreadRumor(
    api, kingdomId,
    `${kingdom} is buying ${names.join(", ")} in bulk - fish prices are climbing!`,
  );
}

function buildFishTables() {
  const I = core.ItemIdentifiers;
  const pairs = [
    ["SHRIMPS", "RAW_SHRIMPS"], ["ANCHOVIES", "RAW_ANCHOVIES"], ["SARDINE", "RAW_SARDINE"],
    ["HERRING", "RAW_HERRING"], ["TROUT", "RAW_TROUT"], ["PIKE", "RAW_PIKE"],
    ["SALMON", "RAW_SALMON"], ["TUNA", "RAW_TUNA"], ["LOBSTER", "RAW_LOBSTER"],
    ["SWORDFISH", "RAW_SWORDFISH"], ["SHARK", "RAW_SHARK"], ["MACKEREL", "RAW_MACKEREL"],
    ["COD", "RAW_COD"], ["BASS", "RAW_BASS"], ["MONKFISH", "RAW_MONKFISH"],
    ["CAVE_EEL", "RAW_CAVE_EEL"], ["LAVA_EEL", "RAW_LAVA_EEL"],
    ["DARK_CRAB", "RAW_DARK_CRAB"], ["ANGLERFISH", "RAW_ANGLERFISH"],
  ];
  cookedToRaw = new Map();
  rawFishIds = new Set();
  fishIds = new Set();
  for (const [cooked, raw] of pairs) {
    if (I[cooked] == null || I[raw] == null) continue;
    cookedToRaw.set(I[cooked], I[raw]);
    rawFishIds.add(I[raw]);
    fishIds.add(I[cooked]);
    fishIds.add(I[raw]);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  buildFishTables();
  api.onCustomEvent("cooking:success", onCooked);
  api.onCustomEvent("cooking:burn", onBurnt);
  api.onCustomEvent(EVENTS.DEMAND, onDemand);
  api.log("registered", { trackedFish: fishIds.size });
}

module.exports = { attach, onCooked, onBurnt, onDemand, itemName, BULK_DEMAND };
