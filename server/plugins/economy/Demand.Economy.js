"use strict";

/**
 * Demand.Economy — the economy:demand open-orders ledger.
 *
 * Any buyer (kingdom quartermaster, master smith needing yew, a player
 * stocking a shop) broadcasts what it needs; this module keeps the open
 * orders so war boards, rumor-spreading citizens, and player merchants can
 * read them. In-memory and expiring — demand is re-broadcast by whoever
 * still needs the goods, which keeps stale orders from haunting the board.
 *
 * Pure module: no api reference. Events.Economy.js owns the api.
 *
 * Record shape:
 *   { id, source, sourceKind?, kingdomId?, items: [{ itemId, amount, priceEach? }],
 *     reason?, postedAt, expiresAt }
 */

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h: a war board's working day

let nextId = 1;
const demands = new Map(); // id -> record

function expire(now = Date.now()) {
  for (const [id, d] of demands) {
    if (d.expiresAt <= now) demands.delete(id);
  }
}

/**
 * Record a demand broadcast. Returns the ledger id (stable for the order's
 * life) or 0 when the payload is unusable.
 */
function record(event, now = Date.now()) {
  if (!event || typeof event.source !== "string") return 0;
  const items = Array.isArray(event.items)
    ? event.items
        .filter((i) => i && Number.isFinite(i.itemId) && i.itemId > 0)
        .map((i) => ({
          itemId: Math.floor(i.itemId),
          amount: Math.max(1, Math.floor(i.amount || 1)),
          priceEach: Number.isFinite(i.priceEach) && i.priceEach > 0 ? Math.floor(i.priceEach) : undefined,
        }))
    : [];
  if (items.length === 0) return 0;
  const id = nextId++;
  const ttl = Number.isFinite(event.ttlMs) && event.ttlMs > 0 ? event.ttlMs : DEFAULT_TTL_MS;
  const postedAt = now;
  demands.set(id, {
    id,
    source: event.source,
    sourceKind: event.sourceKind,
    kingdomId: event.kingdomId,
    items,
    reason: event.reason,
    postedAt,
    expiresAt: Number.isFinite(event.expiresAt) ? event.expiresAt : postedAt + ttl,
  });
  expire(now);
  return id;
}

/**
 * Read the open board. Optional filter: { kingdomId, itemId, sourceKind }.
 * Returns newest-first; expired orders are dropped on read.
 */
function getOpen(filter = {}, now = Date.now()) {
  expire(now);
  const out = [];
  for (const d of demands.values()) {
    if (filter.kingdomId && d.kingdomId !== filter.kingdomId) continue;
    if (filter.sourceKind && d.sourceKind !== filter.sourceKind) continue;
    if (filter.itemId && !d.items.some((i) => i.itemId === filter.itemId)) continue;
    out.push(d);
  }
  out.sort((a, b) => b.postedAt - a.postedAt);
  return out;
}

/** How many open orders right now (expired dropped). */
function openCount(now = Date.now()) {
  expire(now);
  return demands.size;
}

module.exports = {
  DEFAULT_TTL_MS,
  record,
  getOpen,
  openCount,
  _demands: demands, // test seam
};
