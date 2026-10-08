"use strict";

/**
 * CitizenHawker — stock-aware hawking lines for stall merchants.
 *
 * PURE MODULE: no engine imports, no IdEnums, no I/O, no LLM. Callers pass a
 * poolKey (e.g. "bread", "bronze_sword"), the current stock count, the
 * merchant's restock threshold, and an rng function.
 *
 * Lines are picked from stock-tiered template pools:
 *   full  — stock at/above the restock threshold: full-throated adverts.
 *   low   — stock below the threshold but non-zero: "going fast" pitches.
 *   empty — zero stock: returns null. The caller must NOT advertise wares it
 *           doesn't have — silence is the honest pitch.
 *
 * Throttling (ad intervals, chance gates) stays with the caller; this module
 * only answers "what line, if any, for this stock level?"
 */

const HAWKER_POOLS = Object.freeze({
  bread: Object.freeze({
    full: Object.freeze([
      "Fresh bread! Warm from the oven!",
      "Bread, bread! Best in the city, only twelve coins!",
      "Hungry, friend? You look hungry.",
      "Come see, come see — fresh loaves!",
      "Bread for the road, bread for the table!",
    ]),
    low: Object.freeze([
      "Last loaves of the batch — get one while they're warm!",
      "Bread's going fast, friend — I wouldn't wait!",
      "Only a few loaves left! The oven's cooling!",
    ]),
  }),
  bronze_sword: Object.freeze({
    full: Object.freeze([
      "Bronze swords! Honest steel for honest coin!",
      "Swords, swords — arm yourself today!",
      "A blade for every belt, fairly priced!",
    ]),
    low: Object.freeze([
      "Swords nearly gone — last ones, who'll take them?",
      "Down to my last blades! Arm yourself before they're gone!",
      "Only a few swords left — the rack's nearly bare!",
    ]),
  }),
});

const DEFAULT_POOL_KEY = "bread";

/** "full" | "low" | "empty" for a stock count against the restock threshold. */
function stockTier(stock, restockThreshold) {
  const have = Math.max(0, Math.floor(Number(stock) || 0));
  const threshold = Math.max(1, Math.floor(Number(restockThreshold) || 0));
  if (have <= 0) {
    return "empty";
  }
  return have < threshold ? "low" : "full";
}

/**
 * Pick a hawking line for the poolKey/stock level, or null when the shelves
 * are empty (caller stays silent). Unknown poolKey falls back to bread.
 */
function hawkerLine(poolKey, stock, restockThreshold, rng) {
  const pools = HAWKER_POOLS[poolKey] || HAWKER_POOLS[DEFAULT_POOL_KEY];
  const tier = stockTier(stock, restockThreshold);
  if (tier === "empty") {
    return null; // never hawk wares we don't have
  }
  const pool = pools[tier];
  if (!pool || pool.length === 0) {
    return null;
  }
  const r = typeof rng === "function" ? rng : Math.random;
  return pool[Math.floor(r() * pool.length)];
}

module.exports = {
  HAWKER_POOLS,
  DEFAULT_POOL_KEY,
  stockTier,
  hawkerLine,
};
