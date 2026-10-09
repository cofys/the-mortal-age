"use strict";

/**
 * CitizenInventoryApi.test.js — plain node.
 * Regression tests for the citizen dead-inventory-API audit:
 *   - giveCoins credits the mock balance via the canonical adds(id, amount)
 *     (the old add(id, amount) threw inside the real engine, so prizes
 *     silently never arrived)
 *   - takeCoins debits the mock balance via deleteNumber(id, amount)
 *     (the old inv.remove(id, amount) never existed)
 *   - insufficient funds refuses and leaves the balance untouched
 *   - honest failure when the canonical API is absent (no silent true)
 *
 * Run: node server/plugins/citizens/CitizenInventoryApi.test.js
 */

const assert = require("assert");

const COINS = 995;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Canonical mock inventory: mirrors ItemContainer (getAmount, adds,
// deleteNumber). Also carries a throwing add(id, amount) like the real
// engine, so a regression to add(id, amount) fails loudly instead of
// silently "crediting".
function makePlayer(coins, opts) {
  const o = opts || {};
  let c = coins;
  const inv = {
    getAmount: (id) => (id === COINS ? c : 0),
    adds: (id, n) => {
      if (o.noAdds) return;
      if (id === COINS && n > 0) c += n;
    },
    deleteNumber: (id, n) => {
      if (o.noDeleteNumber) return;
      if (id === COINS) c = Math.max(0, c - n);
    },
    // Real engine add(item, refresh) takes an Item object — add(id, amount) throws.
    add: () => { throw new Error("add(id, amount) is not the ItemContainer API"); },
  };
  if (o.noAdds) delete inv.adds;
  if (o.noDeleteNumber) delete inv.deleteNumber;
  return {
    getInventory: () => inv,
    _balance: () => c,
  };
}

// [module, takeFnName, giveFnName, { okShape }]
const MODULES = [
  ["./CitizenArchaeologyEvents", "takeCoins", "giveCoins"],
  ["./CitizenDigGuildEvents", "takeCoins", "giveCoins"],
  ["./CitizenLibrarianGuildEvents", "takeCoins", "giveCoins"],
  ["./CitizenMapGuildEvents", "takeCoins", "giveCoins"],
  ["./CitizenArtGuildEvents", "takeCoins", "giveCoins"],
  ["./CitizenBankGuildEvents", "takeCoins", null],
  ["./CitizenCookGuildEvents", "takeCoins", null],
  ["./CitizenCookOffEvents", "takeCoins", null],
  ["./CitizenDiploCorpsEvents", "takeCoins", null],
  ["./CitizenInsureGuildEvents", "takeCoins", null],
  ["./CitizenLawGuildEvents", "takeCoins", null],
  ["./CitizenMusicFestivalEvents", "takeCoins", null, { okShape: true }],
  ["./CitizenMusicGuildEvents", "takeCoins", null],
  ["./CitizenObservatoryGuildEvents", "takeCoins", null],
  ["./CitizenPressGuildEvents", "takeCoins", null],
  ["./CitizenSportsGuildEvents", "takeCoins", null],
  ["./CitizenSpyEvents", "takeCoins", null],
  ["./CitizenSpyGuildEvents", "takeCoins", null],
  ["./CitizenStageGuildEvents", "takeCoins", null],
  ["./CitizenTradeGuildEvents", "takeCoins", null],
  ["./CitizenTreatyEvents", "takeCoinsFrom", null],
  ["./CitizenWeaverGuildEvents", "takeCoins", null],
];

const norm = (r, okShape) => (okShape ? r && r.ok === true : r === true);

for (const [modPath, takeName, giveName, opts] of MODULES) {
  const mod = require(modPath);
  const okShape = !!(opts && opts.okShape);
  const take = mod[takeName];
  assert.equal(typeof take, "function", `${modPath} exports ${takeName}`);

  test(`${modPath}.${takeName} debits the balance`, () => {
    const p = makePlayer(100);
    assert.ok(norm(take(p, 40), okShape), "returns success");
    assert.strictEqual(p._balance(), 60, "balance debited by exactly 40");
  });

  test(`${modPath}.${takeName} refuses insufficient funds`, () => {
    const p = makePlayer(30);
    assert.ok(!norm(take(p, 40), okShape), "returns failure");
    assert.strictEqual(p._balance(), 30, "balance untouched");
  });

  test(`${modPath}.${takeName} fails honestly without deleteNumber`, () => {
    const p = makePlayer(100, { noDeleteNumber: true });
    assert.ok(!norm(take(p, 40), okShape), "does not claim success");
  });

  test(`${modPath}.${takeName} handles a missing inventory`, () => {
    assert.ok(!norm(take(null, 40), okShape), "null player -> failure");
  });

  if (giveName) {
    const give = mod[giveName];
    assert.equal(typeof give, "function", `${modPath} exports ${giveName}`);

    test(`${modPath}.${giveName} credits the balance`, () => {
      const p = makePlayer(100);
      assert.strictEqual(give(p, 50), true, "returns true");
      assert.strictEqual(p._balance(), 150, "balance credited by exactly 50");
    });

    test(`${modPath}.${giveName} never uses the throwing add(id, amount)`, () => {
      // The mock's add() throws like the real engine; if giveCoins regresses
      // to add(id, amount) this test fails instead of silently lying.
      const p = makePlayer(100);
      assert.strictEqual(give(p, 50), true);
      assert.strictEqual(p._balance(), 150);
    });

    test(`${modPath}.${giveName} refuses non-positive amounts`, () => {
      const p = makePlayer(100);
      assert.strictEqual(give(p, 0), false);
      assert.strictEqual(give(p, -10), false);
      assert.strictEqual(p._balance(), 100, "balance untouched");
    });

    test(`${modPath}.${giveName} fails honestly without adds`, () => {
      const p = makePlayer(100, { noAdds: true });
      assert.strictEqual(give(p, 50), false, "does not claim success");
      assert.strictEqual(p._balance(), 100, "balance untouched");
    });
  }
}

test("CitizenStageGuildEvents.refundCoins best-effort credits", () => {
  const { refundCoins } = require("./CitizenStageGuildEvents");
  assert.equal(typeof refundCoins, "function", "exports refundCoins");
  const p = makePlayer(100);
  refundCoins(p, 50); // void, best-effort
  assert.strictEqual(p._balance(), 150, "refund credited");
  // Must never throw, even with no inventory.
  refundCoins(null, 50);
  refundCoins(makePlayer(100, { noAdds: true }), 50);
});

console.log(`\n${passed} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
