/**
 * Woodcutting feeds the realm's timber economy, for real.
 *
 * Three wires out of the groves, all through documented custom events - this
 * module never touches economy or kingdom internals:
 *
 *   1. Logs burned are logs gone. Every log lit (firemaking:success carries the
 *      log's item id) emits "economy:item-sink" (consumables, "burned"), so the
 *      reference-price feed feels actual consumption: campfires, winter hearths,
 *      wartime firewood. When the world burns faster than cutters cut, log
 *      prices climb - and woodcutters feel it in their coin pouches.
 *   2. The Timber Drive feeds the war effort directly: every log cut on a drive
 *      emits "kingdom:supply-donated" (timber) for the drive's kingdom, and the
 *      kingdom sim grows the quartermaster's stockpile from real axes -
 *      palisades and siege engines, not numbers.
 *   3. When a buyer posts bulk "economy:demand" for logs (a quartermaster
 *      stocking palisades, a fletcher, anyone), cutters hear about it: citizens
 *      spread the word, so the demand board reaches the groves instead of
 *      sitting unread. (War demands themselves are answered by Groves'
 *      wartime quotas and the timber drive, and announced by the realm sim.)
 */
const { EVENTS } = require("../../economy/constants");
const { spreadRumor } = require("./Rumors.Woodcutting");

const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  misthalin: "Misthalin",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

// Bulk demand at or above this many logs is worth spreading word about.
const BULK_DEMAND = 100;

let api = null;
let core = null;
let logIds = new Set();

function itemName(itemId) {
  try {
    return core.ItemDefinition.forId(itemId).getName() ?? "logs";
  } catch (error) {
    return "logs";
  }
}

/** A log left the world in flames: record the consumption sink. */
function onBurned(event) {
  const itemId = event?.itemId == null ? null : Math.floor(event.itemId);
  if (itemId == null || !logIds.has(itemId)) return;
  api.emitCustomEvent(EVENTS.ITEM_SINK, {
    itemId,
    amount: 1,
    sink: "consumables",
    reason: "burned",
  });
}

/** Timber-drive logs go straight to the war effort. */
function onChopped(event) {
  if (!event?.drive || !event?.grove) return;
  api.emitCustomEvent("kingdom:supply-donated", {
    kingdomId: event.grove.kingdom,
    kind: "timber",
    amount: 1,
    itemId: event.logId,
  });
}

/** Bulk log demand: make sure the groves hear about it. */
function onDemand(event) {
  const items = Array.isArray(event?.items) ? event.items : [];
  const wanted = items.filter(
    (item) => item && logIds.has(Math.floor(item.itemId)) && (item.amount ?? 0) >= BULK_DEMAND,
  );
  if (wanted.length === 0) return;
  const kingdomId = event.kingdomId ?? "misthalin";
  const kingdom = KINGDOM_NAMES[kingdomId] ?? event.source ?? "a kingdom";
  const names = [...new Set(wanted.map((item) => itemName(Math.floor(item.itemId))))].slice(0, 3);
  spreadRumor(
    api, kingdomId,
    `${kingdom} is buying ${names.join(", ")} in bulk - timber prices are climbing!`,
  );
}

function buildLogTable() {
  const I = core.ItemIdentifiers;
  const names = [
    "LOGS", "ACHEY_TREE_LOGS", "OAK_LOGS", "WILLOW_LOGS", "TEAK_LOGS", "MAPLE_LOGS",
    "MAHOGANY_LOGS", "YEW_LOGS", "MAGIC_LOGS", "REDWOOD_LOGS", "ARCTIC_PINE_LOGS",
    "BLISTERWOOD_LOGS", "JUNIPER_LOGS", "JATOBA_LOGS", "CAMPHOR_LOGS", "IRONWOOD_LOGS",
  ];
  logIds = new Set();
  for (const name of names) {
    if (I[name] != null) logIds.add(I[name]);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  buildLogTable();
  api.onCustomEvent("firemaking:success", onBurned);
  api.onCustomEvent("woodcutting:success", onChopped);
  api.onCustomEvent(EVENTS.DEMAND, onDemand);
  api.log("registered", { trackedLogs: logIds.size });
}

module.exports = { attach, onBurned, onChopped, onDemand, itemName, BULK_DEMAND };
