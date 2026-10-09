"use strict";

/**
 * Fees.Economy — the quiet gold drain.
 *
 * Listens for the GE plugin's ge:offer-collected event. When a SELL offer is
 * collected (the payout is coins), 1% of the coins are removed from the
 * destination container and destroyed — a market fee, sunk, not transferred.
 * Buy offers (payout is items) are untouched: the seller already paid.
 *
 * This is the money-supply counterpart to the item sinks: sinks destroy
 * goods (driving crafter demand), the fee destroys coins (fighting the
 * faucet of alchemy, drops, and shop sales). Both are tuned in constants.js.
 *
 * Silent by design (Jon 2026-10-06): no chat spam. Lifetime totals are
 * visible in ::economy.
 */

const { COINS_ID, FEE_TUNING } = require("./constants");

const stats = { feesCollected: 0, feesValue: 0 };

function onOfferCollected(event) {
  if (!event || event.itemId !== COINS_ID) return; // sell offers pay out in coins
  // Only a completed SELL is taxed: sell === true and not aborted. An aborted
  // BUY pays the player's own coins back — taxing those would take money the
  // player never earned. Unknown offer shapes fail closed (no tax).
  if (event.sell !== true || event.aborted) return;
  const amount = Math.floor(event.amount ?? 0);
  if (amount <= 0) return;
  const fee = Math.floor(amount * FEE_TUNING.geCompletionFee);
  if (fee <= 0) return;

  const container = event.container;
  if (!container || typeof container.deleted !== "function") return;
  // The container already holds the payout (the GE plugin hands over, then
  // emits). Remove the fee's share; refresh so the client sees it.
  const before = typeof container.getAmount === "function" ? container.getAmount(COINS_ID) : fee;
  container.deleted(COINS_ID, fee, true);
  const after = typeof container.getAmount === "function" ? container.getAmount(COINS_ID) : before - fee;
  const removed = Math.max(0, before - after);
  if (removed > 0) {
    stats.feesCollected += 1;
    stats.feesValue += removed;
  }
}

function getStats() {
  return { ...stats };
}

module.exports = function attachFees(api) {
  api.onCustomEvent("ge:offer-collected", onOfferCollected);
};

module.exports.onOfferCollected = onOfferCollected;
module.exports.getStats = getStats;
