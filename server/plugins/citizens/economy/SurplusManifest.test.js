"use strict";

/**
 * SurplusManifest unit checks — the phase-4 data model.
 *
 * Banked goods move only when verified: withdrawals debit the bank and
 * credit the pack with before/after checks, and a failed credit rolls the
 * debit back. No minting, no vanishing, no duplication.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Manifest = require("./SurplusManifest");

function mockContainer(amounts = {}, freeSlots = 27) {
  const m = { ...amounts };
  return {
    getAmount: (id) => m[id] ?? 0,
    deleteNumber: (id, n) => {
      m[id] = Math.max(0, (m[id] ?? 0) - n);
    },
    adds: (id, n) => {
      m[id] = (m[id] ?? 0) + n;
    },
    getFreeSlots: () => freeSlots,
    _m: m,
  };
}

function mockPlayer(bankAmounts, invAmounts = {}, freeSlots = 27) {
  const bank = mockContainer(bankAmounts);
  const inv = mockContainer(invAmounts, freeSlots);
  return {
    getBank: (tab) => (tab === 0 ? bank : null),
    getInventory: () => inv,
    _bank: bank,
    _inv: inv,
  };
}

describe("SurplusManifest", () => {
  beforeEach(() => Manifest._resetManifest());

  it("surplusOf keeps the personal reserve; unknown items never move", () => {
    assert.equal(Manifest.surplusOf(20, 317), 8); // 20 shrimps - 12 reserve
    assert.equal(Manifest.surplusOf(5, 317), 0);
    assert.equal(Manifest.surplusOf(100, 99999), 0);
    assert.equal(Manifest.surplusOf(14, 1511), 6); // timber reserve 8
  });

  it("isWarSupplyItem matches the quartermaster's buy list", () => {
    assert.ok(Manifest.isWarSupplyItem(1511)); // logs -> materials
    assert.ok(Manifest.isWarSupplyItem(2309)); // bread -> food
    assert.ok(!Manifest.isWarSupplyItem(317)); // raw shrimps: not war stock
    assert.ok(!Manifest.isWarSupplyItem(440)); // iron ore: not war stock
  });

  it("warSupplySpec carries units + category for routing", () => {
    assert.deepEqual(Manifest.warSupplySpec(1511), { units: 4, cat: "materials" });
    assert.deepEqual(Manifest.warSupplySpec(2309), { units: 2, cat: "food" });
    assert.equal(Manifest.warSupplySpec(317), null);
  });

  it("bankTotal sums every tab", () => {
    const p = mockPlayer({ 317: 10 });
    p.getBank = (tab) => (tab < 2 ? mockContainer({ 317: tab === 0 ? 10 : 7 }) : null);
    assert.equal(Manifest.bankTotal(p, 317), 17);
    assert.equal(Manifest.bankTotal(p, 440), 0);
  });

  it("withdrawFromBank moves verified amounts, nothing fabricated", () => {
    const p = mockPlayer({ 317: 20 });
    const moved = Manifest.withdrawFromBank(p, 317, 8);
    assert.equal(moved, 8);
    assert.equal(p._bank.getAmount(317), 12);
    assert.equal(p._inv.getAmount(317), 8);
  });

  it("withdrawFromBank takes only what the bank holds", () => {
    const p = mockPlayer({ 317: 3 });
    const moved = Manifest.withdrawFromBank(p, 317, 50);
    assert.equal(moved, 3);
    assert.equal(p._bank.getAmount(317), 0);
    assert.equal(p._inv.getAmount(317), 3);
  });

  it("withdrawFromBank refuses unstackables when the pack is full", () => {
    const p = mockPlayer({ 440: 30 }, {}, 0);
    const moved = Manifest.withdrawFromBank(p, 440, 10);
    assert.equal(moved, 0);
    assert.equal(p._bank.getAmount(440), 30);
    assert.equal(p._inv.getAmount(440), 0);
  });

  it("withdrawFromBank rolls the debit back when the credit fails", () => {
    const p = mockPlayer({ 317: 20 });
    p._inv.adds = () => {
      throw new Error("pack exploded");
    };
    const moved = Manifest.withdrawFromBank(p, 317, 8);
    assert.equal(moved, 0);
    assert.equal(p._bank.getAmount(317), 20); // restored
  });

  it("referencePrice is the living-economy price, never zero", () => {
    const price = Manifest.referencePrice(317);
    assert.ok(Number.isFinite(price) && price >= 1, `price ${price}`);
  });

  it("recordMovement keeps an origin-tagged ring buffer", () => {
    Manifest.recordMovement({
      kind: "peer-sale",
      itemId: 317,
      qty: 8,
      originKingdom: "asgarnia",
      seller: "Fisher A",
      buyer: "Buyer B",
      coins: 24,
    });
    const [m] = Manifest.recentMovements(1);
    assert.equal(m.kind, "peer-sale");
    assert.equal(m.itemId, 317);
    assert.equal(m.qty, 8);
    assert.equal(m.originKingdom, "asgarnia");
    assert.equal(m.coins, 24);
    // Junk entries are dropped, not recorded.
    Manifest.recordMovement({ kind: "peer-sale", itemId: 317, qty: 0 });
    assert.equal(Manifest.recentMovements(10).length, 1);
  });
});
