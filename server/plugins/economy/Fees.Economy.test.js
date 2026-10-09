"use strict";

/**
 * Fees.Economy.test.js — the 1% GE completion fee only taxes completed sells.
 * Plain node, no jest. Run: node server/plugins/economy/Fees.Economy.test.js
 *
 * Regression test: aborting a BUY offer returns the player's own coins.
 * Charging the fee there stole 1% of money the player never earned.
 */

const assert = require("assert");
const Fees = require("./Fees.Economy");

const COINS = 995;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

// Minimal container: real coin-counting semantics.
function mockContainer(startingCoins) {
  let coins = startingCoins;
  return {
    getAmount: (id) => (id === COINS ? coins : 0),
    deleted: (id, amount, refresh) => {
      if (id === COINS && amount > 0) coins = Math.max(0, coins - amount);
    },
    _coins: () => coins,
  };
}

test("completed SELL collect is taxed 1%", () => {
  const container = mockContainer(1_000_000);
  Fees.onOfferCollected({
    itemId: COINS, amount: 1_000_000,
    destination: "inventory", container,
    sell: true, aborted: false,
  });
  assert.strictEqual(container._coins(), 990_000, "1% fee removed");
});

test("aborted BUY collect is NOT taxed (own coins back)", () => {
  const container = mockContainer(1_000_000);
  Fees.onOfferCollected({
    itemId: COINS, amount: 1_000_000,
    destination: "inventory", container,
    sell: false, aborted: true,
  });
  assert.strictEqual(container._coins(), 1_000_000, "aborted buy returns every coin");
});

test("aborted SELL collect is NOT taxed (items back, not coins anyway)", () => {
  const container = mockContainer(500_000);
  Fees.onOfferCollected({
    itemId: 1234, amount: 100, // items, not coins
    destination: "inventory", container,
    sell: true, aborted: true,
  });
  assert.strictEqual(container._coins(), 500_000, "untouched");
});

test("completed BUY collect is NOT taxed (payout is items)", () => {
  const container = mockContainer(500_000);
  Fees.onOfferCollected({
    itemId: 1234, amount: 100,
    destination: "inventory", container,
    sell: false, aborted: false,
  });
  assert.strictEqual(container._coins(), 500_000, "untouched");
});

test("fee rounds down; tiny payouts pay nothing", () => {
  const container = mockContainer(50);
  Fees.onOfferCollected({
    itemId: COINS, amount: 50,
    destination: "bank", container,
    sell: true, aborted: false,
  });
  assert.strictEqual(container._coins(), 50, "50 coins -> 0 fee");
});

test("missing offer flags default to no-tax (safe side)", () => {
  // An event without sell/aborted info must not be taxed — fail closed.
  const container = mockContainer(1_000_000);
  Fees.onOfferCollected({ itemId: COINS, amount: 1_000_000, container });
  assert.strictEqual(container._coins(), 1_000_000, "unknown offer type not taxed");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
