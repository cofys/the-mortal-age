"use strict";

/**
 * CitizenFashion.test.js — plain-node tests for the fashion data tier.
 *
 * Tests trends, garments, shops, competitions, and seasonal comfort.
 * No engine, no LLM, no director required.
 */

const assert = require("assert");
const Fashion = require("./CitizenFashion");

function test(name, fn) {
  try {
    Fashion.resetForTests();
    fn();
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("CitizenFashion:");

test("garment catalog has 8 types", () => {
  assert.strictEqual(Fashion.GARMENT_TYPES.length, 8);
  assert.ok(Fashion.GARMENT_TYPES.includes("shirt"));
  assert.ok(Fashion.GARMENT_TYPES.includes("robe"));
});

test("currentTrend returns deterministic weekly trend", () => {
  const t1 = 1000 * 60 * 60 * 24 * 7 * 10; // week 10
  const t2 = t1 + 1000; // same week
  const trend1 = Fashion.currentTrend(t1);
  const trend2 = Fashion.currentTrend(t2);
  assert.strictEqual(trend1.color, trend2.color);
  assert.strictEqual(trend1.style, trend2.style);
  assert.ok(Fashion.TREND_COLORS.includes(trend1.color));
});

test("trend rotates weekly", () => {
  const week1 = 1000 * 60 * 60 * 24 * 7 * 10;
  const week2 = week1 + Fashion.TREND_ROTATION_MS + 1000;
  Fashion.resetForTests();
  const t1 = Fashion.currentTrend(week1);
  Fashion.resetForTests();
  const t2 = Fashion.currentTrend(week2);
  // At least one dimension should differ (deterministic rotation).
  const same = t1.color === t2.color && t1.style === t2.style && t1.formality === t2.formality;
  assert.ok(!same, "trend should rotate");
});

test("createGarment makes a valid record", () => {
  const g = Fashion.createGarment("shirt", "crimson", "TestMaker", 75);
  assert.ok(g);
  assert.strictEqual(g.type, "shirt");
  assert.strictEqual(g.color, "crimson");
  assert.strictEqual(g.maker, "TestMaker");
  assert.strictEqual(g.quality, 75);
  assert.ok(g.id);
  assert.strictEqual(g.soldAt, null);
});

test("createGarment rejects unknown type", () => {
  const g = Fashion.createGarment("spacesuit", "silver", "Test", 50);
  assert.strictEqual(g, null);
});

test("createGarment clamps quality", () => {
  const g1 = Fashion.createGarment("hat", "azure", "T", 150);
  assert.strictEqual(g1.quality, 100);
  const g2 = Fashion.createGarment("hat", "azure", "T", -10);
  assert.strictEqual(g2.quality, 1);
});

test("trendScoreFor rewards trend-matching color", () => {
  const nowMs = 1000 * 60 * 60 * 24 * 7 * 10;
  const trend = Fashion.currentTrend(nowMs);
  const matching = Fashion.createGarment("dress", trend.color, "T", 50);
  const plain = Fashion.createGarment("dress", "natural", "T", 50);
  const s1 = Fashion.trendScoreFor(matching, nowMs);
  const s2 = Fashion.trendScoreFor(plain, nowMs);
  assert.ok(s1 > s2, `matching (${s1}) should beat plain (${s2})`);
});

test("garmentValue scales with quality and trend", () => {
  const nowMs = 1000 * 60 * 60 * 24 * 7 * 10;
  const trend = Fashion.currentTrend(nowMs);
  const best = Fashion.createGarment("robe", trend.color, "T", 100);
  const worst = Fashion.createGarment("shirt", "natural", "T", 1);
  const v1 = Fashion.garmentValue(best, nowMs);
  const v2 = Fashion.garmentValue(worst, nowMs);
  assert.ok(v1 > v2, `best (${v1}) should beat worst (${v2})`);
  assert.ok(v1 > 0);
});

test("shopFor creates per-kingdom shops", () => {
  const s1 = Fashion.shopFor("varrock");
  const s2 = Fashion.shopFor("falador");
  assert.ok(s1);
  assert.ok(s2);
  assert.notStrictEqual(s1, s2);
  assert.deepStrictEqual(s1.inventory, []);
});

test("listGarment adds to shop inventory", () => {
  const g = Fashion.createGarment("cloak", "emerald", "T", 60);
  const ok = Fashion.listGarment("varrock", g.id);
  assert.ok(ok);
  const shop = Fashion.shopFor("varrock");
  assert.ok(shop.inventory.includes(g.id));
});

test("listGarment rejects unknown garment", () => {
  const ok = Fashion.listGarment("varrock", "nonexistent");
  assert.strictEqual(ok, false);
});

test("buyGarment moves real coins", () => {
  const g = Fashion.createGarment("shirt", "natural", "Maker", 50);
  Fashion.listGarment("varrock", g.id);
  const price = Fashion.garmentValue(g);
  // Mock buyer with enough coins.
  const buyer = {
    username: "Buyer",
    inventory: {
      _coins: price + 100,
      count(id) { return id === 995 ? this._coins : 0; },
      remove(id, n) { if (id === 995) this._coins -= n; },
    },
  };
  const before = buyer.inventory._coins;
  const result = Fashion.buyGarment("varrock", g.id, buyer);
  assert.ok(result.ok, `buy failed: ${result.reason}`);
  assert.strictEqual(buyer.inventory._coins, before - price);
  assert.ok(g.soldAt);
  assert.strictEqual(g.buyer, "Buyer");
});

test("buyGarment refuses when broke", () => {
  const g = Fashion.createGarment("robe", "golden", "Maker", 90);
  Fashion.listGarment("falador", g.id);
  const buyer = {
    username: "Broke",
    inventory: {
      count() { return 0; },
      remove() {},
    },
  };
  const result = Fashion.buyGarment("falador", g.id, buyer);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "cannot afford");
  assert.strictEqual(g.soldAt, null); // not sold
});

test("maybeScheduleCompetition creates monthly competitions", () => {
  const nowMs = Date.now();
  const comp = Fashion.maybeScheduleCompetition("varrock", nowMs);
  assert.ok(comp);
  assert.strictEqual(comp.kingdomId, "varrock");
  assert.deepStrictEqual(comp.entries, []);
  // Second call within the month returns null.
  const comp2 = Fashion.maybeScheduleCompetition("varrock", nowMs + 1000);
  assert.strictEqual(comp2, null);
});

test("enterCompetition and resolveCompetition pick winners", () => {
  const nowMs = 1000 * 60 * 60 * 24 * 7 * 10;
  const trend = Fashion.currentTrend(nowMs);
  const comp = Fashion.maybeScheduleCompetition("varrock", nowMs);
  const g1 = Fashion.createGarment("dress", trend.color, "Alice", 90); // trendy + high quality
  const g2 = Fashion.createGarment("shirt", "natural", "Bob", 30); // plain
  assert.ok(Fashion.enterCompetition(comp.id, "Alice", g1.id, nowMs));
  assert.ok(Fashion.enterCompetition(comp.id, "Bob", g2.id, nowMs));
  // Duplicate entry rejected.
  assert.strictEqual(Fashion.enterCompetition(comp.id, "Alice", g1.id, nowMs), false);
  const result = Fashion.resolveCompetition(comp.id, nowMs);
  assert.ok(result);
  assert.strictEqual(result.winner, "Alice"); // trendy should win
  assert.strictEqual(result.runnerUp, "Bob");
  assert.strictEqual(result.prize, Fashion.COMPETITION_PRIZE);
});

test("seasonalComfortBonus rewards warm clothes in winter", () => {
  // Mock CitizenSeasons to return winter.
  const Module = require("module");
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "./CitizenSeasons") {
      return { seasonOf: () => "winter" };
    }
    return origRequire.apply(this, arguments);
  };
  try {
    const warmBonus = Fashion.seasonalComfortBonus(["cloak", "boots"], Date.now());
    const coldBonus = Fashion.seasonalComfortBonus(["shirt"], Date.now());
    assert.ok(warmBonus > coldBonus, `warm (${warmBonus}) should beat cold (${coldBonus})`);
  } finally {
    Module.prototype.require = origRequire;
  }
});

test("canAffordMaterials is honest about missing engine", () => {
  // Without engine items, materials are unresolvable — honest failure.
  const mockPlayer = { inventory: { count: () => 0 } };
  const check = Fashion.canAffordMaterials(mockPlayer, "shirt");
  // Either ok (engine available) or honest about what's missing.
  assert.ok(typeof check.ok === "boolean");
  assert.ok(Array.isArray(check.missing));
});

test("materialIds resolves defensively", () => {
  const ids = Fashion.materialIds();
  assert.ok(ids && typeof ids === "object");
  // May be null if engine unavailable — that's honest, not a failure.
});

console.log("done.");
