"use strict";

/**
 * CitizenCoinAudit.test.js — dead-inventory-API audit regression tests.
 *
 * The citizens lib coin helpers used to probe `inv.count` / `inv.remove`
 * (neither exists on the engine ItemContainer) and `inv.add(id, amount)`
 * (wrong overload — add takes an Item object, so it threw on live
 * inventories). They now go through the canonical engine API only:
 * getAmount / deleteNumber / adds, with balance verification on every move.
 *
 * These tests prove, per module, that:
 *   (a) takeCoins actually reduces the balance,
 *   (b) giveCoins actually credits,
 *   (c) coinCount reads real amounts,
 *   (d) broke / insufficient-funds honestly refuses (no silent success),
 *   (e) a lying inventory (deleteNumber/adds that don't move the balance)
 *       is caught by verification instead of reported as success.
 *
 * From server/plugins/citizens/lib: node CitizenCoinAudit.test.js (plain node)
 */
const assert = require("node:assert/strict");

const COINS = 995;

// --- real-API mock inventory (mirrors ItemContainer#getAmount/deleteNumber/adds)
function mockInventory(seed = {}) {
  const amounts = { ...seed };
  const inv = {
    getAmount: (id) => amounts[id] ?? 0,
    deleteNumber: (id, qty) => {
      amounts[id] = Math.max(0, (amounts[id] ?? 0) - qty);
      return inv;
    },
    adds: (id, qty) => {
      amounts[id] = (amounts[id] ?? 0) + qty;
      return inv;
    },
  };
  return inv;
}

// An inventory whose mutators lie: they accept the call but never move the
// balance. The old code reported success for these; verification must refuse.
function lyingInventory(balance = 500) {
  return {
    getAmount: () => balance,
    deleteNumber: () => {},
    adds: () => {},
  };
}

const MODULES = [
  ["CitizenArt", "./CitizenArt"],
  ["CitizenCivilLife", "./CitizenCivilLife"],
  ["CitizenCrime", "./CitizenCrime"],
  ["CitizenBankGuildLife", "./CitizenBankGuildLife"],
  ["CitizenCivilLaw", "./CitizenCivilLaw"],
  ["CitizenEntertainment", "./CitizenEntertainment"],
  ["CitizenGalleries", "./CitizenGalleries"],
  ["CitizenGuilds", "./CitizenGuilds"],
  ["CitizenMapLife", "./CitizenMapLife"],
  ["CitizenTournaments", "./CitizenTournaments"],
  ["CitizenTradeCharters", "./CitizenTradeCharters"],
  ["CitizenTravel", "./CitizenTravel"],
];

let passed = 0;

for (const [name, rel] of MODULES) {
  const mod = require(rel);
  assert.equal(
    typeof mod._coinHelpersForTests,
    "function",
    `${name} must export the _coinHelpersForTests seam`
  );
  const { coinCount, takeCoins, giveCoins } = mod._coinHelpersForTests();
  for (const [fnName, fn] of [["coinCount", coinCount], ["takeCoins", takeCoins], ["giveCoins", giveCoins]]) {
    assert.equal(typeof fn, "function", `${name}: seam must expose ${fnName}`);
  }

  // (c) coinCount reads real amounts, never invents, never throws.
  {
    const inv = mockInventory({ [COINS]: 500, 1234: 7 });
    assert.equal(coinCount(inv, COINS), 500, `${name}: reads coins`);
    assert.equal(coinCount(inv, 1234), 7, `${name}: reads other items`);
    assert.equal(coinCount(inv, 9999), 0, `${name}: unknown id is 0`);
    assert.equal(coinCount(null, COINS), 0, `${name}: null inventory is 0`);
    assert.equal(coinCount(undefined, COINS), 0, `${name}: undefined inventory is 0`);
    assert.equal(coinCount({}, COINS), 0, `${name}: missing getAmount is 0, not a throw`);
    passed++;
    console.log(`ok - ${name}: coinCount reads real amounts`);
  }

  // (a) takeCoins actually reduces the balance.
  {
    const inv = mockInventory({ [COINS]: 500 });
    assert.equal(takeCoins(inv, COINS, 200), true, `${name}: take succeeds`);
    assert.equal(inv.getAmount(COINS), 300, `${name}: balance reduced 500 -> 300`);
    assert.equal(takeCoins(inv, COINS, 300), true, `${name}: take exact balance`);
    assert.equal(inv.getAmount(COINS), 0, `${name}: balance at zero`);
    passed++;
    console.log(`ok - ${name}: takeCoins reduces the balance`);
  }

  // (d) broke / insufficient-funds honestly refuses; balance untouched.
  {
    const inv = mockInventory({ [COINS]: 300 });
    assert.equal(takeCoins(inv, COINS, 301), false, `${name}: insufficient refused`);
    assert.equal(inv.getAmount(COINS), 300, `${name}: refused take leaves balance alone`);
    assert.equal(takeCoins(inv, COINS, 0), false, `${name}: zero take refused`);
    assert.equal(takeCoins(inv, COINS, -50), false, `${name}: negative take refused`);
    assert.equal(takeCoins(null, COINS, 10), false, `${name}: null inventory refused`);
    const empty = mockInventory({});
    assert.equal(takeCoins(empty, COINS, 1), false, `${name}: empty inventory refused`);
    passed++;
    console.log(`ok - ${name}: takeCoins refuses insufficient funds honestly`);
  }

  // (b) giveCoins actually credits.
  {
    const inv = mockInventory({ [COINS]: 300 });
    assert.equal(giveCoins(inv, COINS, 150), true, `${name}: give succeeds`);
    assert.equal(inv.getAmount(COINS), 450, `${name}: balance credited 300 -> 450`);
    const fresh = mockInventory({});
    assert.equal(giveCoins(fresh, COINS, 25), true, `${name}: give to empty inventory`);
    assert.equal(fresh.getAmount(COINS), 25, `${name}: empty inventory credited`);
    assert.equal(giveCoins(inv, COINS, 0), false, `${name}: zero give refused`);
    assert.equal(giveCoins(null, COINS, 10), false, `${name}: null inventory give refused`);
    passed++;
    console.log(`ok - ${name}: giveCoins credits the balance`);
  }

  // (e) verification catches a lying inventory — no silent success.
  {
    const lying = lyingInventory(500);
    assert.equal(takeCoins(lying, COINS, 100), false, `${name}: lying deleteNumber caught`);
    assert.equal(giveCoins(lying, COINS, 100), false, `${name}: lying adds caught`);
    passed++;
    console.log(`ok - ${name}: balance verification catches lying inventories`);
  }
}

console.log(`\nALL COIN AUDIT TESTS PASSED (${passed} checks across ${MODULES.length} modules)`);
