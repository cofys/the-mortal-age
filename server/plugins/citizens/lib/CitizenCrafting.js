"use strict";

/**
 * CitizenCrafting — the supply chain's root. Data tier, zero LLM.
 *
 * The merchant kinds already tell a production story: the supplier forges
 * swords, the provisioner bakes bread, the prime retails. This module makes
 * that story real — crafters produce finished goods on wall-clock time,
 * online or off, and the goods flow into their inventory (or a roster
 * stockpile that materializes on spawn). The supplier's swords and the
 * provisioner's loaves are no longer seeded once and forgotten; they are
 * made, by hand, over time.
 *
 * The chain, end to end:
 *   supplier forges swords ─┬─► sells at their own stall
 *                           └─► prime wholesales from supplier (PrimeMerchant)
 *   provisioner bakes bread ───► sells at their own stall
 *
 * Production accrues on the roster record (survives logout), capped so a
 * week of downtime doesn't mint a warehouse. Every batch is journaled so
 * the foreground LLM talks about the work truthfully ("spent the morning
 * at the forge").
 */

const { getJournal } = require("./CitizenJournal");

// Verified against server/plugins/citizens/director/CitizenDirector.js
// (ItemIds.BRONZE_SWORD ?? 1277, ItemIds.BREAD ?? 2309).
const FALLBACK_IDS = Object.freeze({ BRONZE_SWORD: 1277, BREAD: 2309 });

/**
 * Craft specs keyed by merchantKind. timeMs is wall-clock per batch;
 * production accrues whether the citizen is online or not (background
 * labor), and the stockpile cap keeps long downtimes sane.
 */
const CRAFT_SPECS = Object.freeze({
  supplier: {
    itemKey: "BRONZE_SWORD",
    batchQty: 1,
    timeMs: 40 * 60 * 1000,
    stockCap: 60,
    verb: "forged",
    verbPlace: "at the forge",
    journalKind: "craft",
  },
  provisioner: {
    itemKey: "BREAD",
    batchQty: 4,
    timeMs: 30 * 60 * 1000,
    stockCap: 80,
    verb: "baked",
    verbPlace: "in the ovens",
    journalKind: "craft",
  },
  // The prime is a pure retailer — buys wholesale, sells retail. No spec.
});

function resolveItemId(director, itemKey) {
  try {
    const ids = director?.api?.core?.ItemIds ?? {};
    const id = ids[itemKey];
    if (Number.isInteger(id)) return id;
  } catch {
    // Fall through to the verified fallback.
  }
  return FALLBACK_IDS[itemKey] ?? null;
}

function itemName(director, itemId) {
  try {
    return (
      director?.api?.core?.ItemDefinition?.forId?.(itemId)?.getName?.() ??
      String(itemId)
    );
  } catch {
    return String(itemId);
  }
}

function craftSpecFor(record) {
  if (!record || record.role !== "merchant") return null;
  return CRAFT_SPECS[record.merchantKind] ?? null;
}

/**
 * Advance production for every crafter on the roster. Called from the
 * director tick (data tier). Elapsed time is capped per tick so a long
 * outage produces one honest journal line, not a warehouse.
 */
function tickCrafting(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  const MAX_ELAPSED_MS = 4 * 3600 * 1000;
  for (const record of director.roster.values()) {
    const spec = craftSpecFor(record);
    if (!spec) continue;
    const lastAt = Number.isFinite(record.craftLastAt)
      ? record.craftLastAt
      : nowMs;
    const elapsed = Math.min(Math.max(0, nowMs - lastAt), MAX_ELAPSED_MS);
    record.craftLastAt = nowMs;
    if (elapsed <= 0) continue;
    record.craftAccruedMs = (record.craftAccruedMs ?? 0) + elapsed;
    const batches = Math.floor(record.craftAccruedMs / spec.timeMs);
    if (batches <= 0) continue;
    record.craftAccruedMs -= batches * spec.timeMs;
    const itemId = resolveItemId(director, spec.itemKey);
    if (!Number.isInteger(itemId)) continue;
    const qty = batches * spec.batchQty;
    const name = itemName(director, itemId);
    const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
    let toInventory = 0;
    let toStockpile = qty;
    if (bot) {
      try {
        const inv = bot.getInventory?.();
        const free = inv?.getFreeSlots?.() ?? 0;
        // Swords don't stack; bread does. Be conservative: one free slot
        // per sword, a single slot for the whole bread batch.
        const stackable =
          director?.api?.core?.ItemDefinition?.forId?.(itemId)?.isStackable?.() ===
          true;
        const slotsNeeded = stackable ? 1 : qty;
        if (free >= slotsNeeded) {
          toInventory = qty;
          toStockpile = 0;
          inv.adds(itemId, qty);
        } else if (stackable && inv?.containsNumber?.(itemId)) {
          toInventory = qty;
          toStockpile = 0;
          inv.adds(itemId, qty);
        }
      } catch {
        toInventory = 0;
        toStockpile = qty;
      }
    }
    if (toStockpile > 0) {
      record.craftStockpile = record.craftStockpile ?? {};
      const key = String(itemId);
      record.craftStockpile[key] = Math.min(
        spec.stockCap,
        (record.craftStockpile[key] ?? 0) + toStockpile
      );
    }
    try {
      const where = bot ? ` (${toInventory} to the stall stock)` : " (stockpiled)";
      getJournal().log(
        record.username,
        spec.journalKind,
        `${spec.verb[0].toUpperCase() + spec.verb.slice(1)} ${qty} x ${name} ${spec.verbPlace}${where}.`,
        { data: { itemId, qty } }
      );
    } catch {
      // Journaling must never break the tick.
    }
  }
}

/**
 * Move a citizen's accrued stockpile into their live inventory on spawn.
 * Called from the director right after the seeded inventory is set.
 */
function claimStockpile(record, bot) {
  const pile = record?.craftStockpile;
  if (!pile || !bot) return 0;
  let moved = 0;
  try {
    const inv = bot.getInventory?.();
    if (!inv) return 0;
    for (const [key, qty] of Object.entries(pile)) {
      const itemId = Number(key);
      const amount = Math.floor(Number(qty));
      if (!Number.isInteger(itemId) || amount <= 0) continue;
      try {
        inv.adds(itemId, amount);
        moved += amount;
      } catch {
        // Inventory full or add failed — leave the rest stockpiled.
        break;
      }
    }
  } catch {
    return moved;
  }
  if (moved > 0) {
    // Only clear what actually moved.
    let remaining = moved;
    for (const key of Object.keys(pile)) {
      if (remaining <= 0) break;
      const had = pile[key];
      const take = Math.min(had, remaining);
      pile[key] = had - take;
      remaining -= take;
      if (pile[key] <= 0) delete pile[key];
    }
    try {
      getJournal().log(
        record.username,
        "restock",
        `Brought ${moved} crafted goods out of the stockpile to the stall.`,
        { data: { moved } }
      );
    } catch {
      // Non-fatal.
    }
  }
  return moved;
}

module.exports = {
  CRAFT_SPECS,
  craftSpecFor,
  tickCrafting,
  claimStockpile,
};
