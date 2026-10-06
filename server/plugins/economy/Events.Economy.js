"use strict";

/**
 * Events.Economy — the economy:* custom-event listeners. This is the
 * cross-plugin API of the ECONOMY system: the emitter owns the name and
 * payload shape, the listener owns the handler. Payloads stay small on
 * purpose — they're the seam future LLM hooks (AI quartermasters, merchant
 * citizens) will read.
 *
 * Payloads:
 *   economy:item-sink { itemId, amount, sink, zone?, victim?, killer?, reason? }
 *     — items left the world permanently. Recorded as scarcity pressure on
 *       the reference price; a >10% move emits economy:price.
 *   economy:demand    { source, sourceKind?, kingdomId?, items: [{ itemId, amount, priceEach? }],
 *                       reason?, ttlMs?, expiresAt? }
 *     — a buyer needs supplies. Kept on the open-orders ledger; each item
 *       adds demand pressure on the reference price (broadcast on >10% move).
 *   economy:price     { itemId, price, previous, reason? }
 *     — emitted BY this plugin when a reference price moves; consumed by
 *       citizen merchants (stall repricing), war boards, and players.
 *   economy:price-query { itemId, respond(price|null) }
 *     — synchronous lookup: the handler calls respond() with the current
 *       reference price (or null when unanswerable) before returning.
 *       Used by citizen merchant stalls to price wares.
 */

const { EVENTS } = require("./constants");
const Prices = require("./Prices.Economy");
const Demand = require("./Demand.Economy");

let pluginApi = null;

/** A sink event arrived: scarcity pressure, maybe a price broadcast. */
function onItemSink(event) {
  const itemId = event?.itemId;
  if (!Number.isFinite(itemId) || itemId <= 0) return;
  const broadcast = Prices.recordSink(Math.floor(itemId));
  if (broadcast) pluginApi.emitCustomEvent(EVENTS.PRICE, broadcast);
}

/** A demand broadcast arrived: ledger it, pressure its items, maybe broadcast prices. */
function onDemand(event) {
  if (!event) return;
  Demand.record(event);
  const items = Array.isArray(event.items) ? event.items : [];
  for (const item of items) {
    if (!item || !Number.isFinite(item.itemId)) continue;
    const broadcast = Prices.recordDemand(Math.floor(item.itemId));
    if (broadcast) pluginApi.emitCustomEvent(EVENTS.PRICE, broadcast);
  }
}

/** A price query arrived: answer synchronously through the reply callback. */
function onPriceQuery(event) {
  const respond = event?.respond;
  if (typeof respond !== "function") return;
  const itemId = Math.floor(Number(event?.itemId));
  if (!Number.isFinite(itemId) || itemId <= 0) {
    respond(null);
    return;
  }
  respond(Prices.getReferencePrice(itemId));
}

module.exports = function attachEvents(api) {
  pluginApi = api;
  api.onCustomEvent(EVENTS.ITEM_SINK, onItemSink);
  api.onCustomEvent(EVENTS.DEMAND, onDemand);
  api.onCustomEvent(EVENTS.PRICE_QUERY, onPriceQuery);
};

module.exports.onItemSink = onItemSink;
module.exports.onDemand = onDemand;
