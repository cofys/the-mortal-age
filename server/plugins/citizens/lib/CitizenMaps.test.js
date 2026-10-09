"use strict";

/**
 * CitizenMaps.test.js — plain-node tests for the real cartography data tier.
 *
 * Run: node server/plugins/citizens/lib/CitizenMaps.test.js
 */

const assert = require("assert");

const Maps = require("./CitizenMaps");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Maps.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenMaps tests:");

// --- catalog ---

test("map types cover all four kinds", () => {
  assert.deepStrictEqual([...Maps.MAP_TYPES].sort(), ["city", "dungeon", "treasure", "world"]);
});

test("material cost is real papyrus", () => {
  const cost = Maps.materialCost();
  assert.strictEqual(cost.length, 1);
  assert.strictEqual(cost[0].item, 970);
  assert.strictEqual(cost[0].consumed, true);
});

// --- cartographers ---

test("registerCartographer is honest about identity", () => {
  assert.strictEqual(Maps.registerCartographer("", "misthalin").ok, false);
  assert.strictEqual(Maps.registerCartographer("Alice", null).ok, false);
  const r = Maps.registerCartographer("Alice", "misthalin");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, false);
  assert.strictEqual(Maps.isCartographer("alice"), true); // normalized
  assert.strictEqual(Maps.isCartographer("bob"), false);
});

test("double registration is idempotent", () => {
  Maps.registerCartographer("Alice", "misthalin");
  const r = Maps.registerCartographer("Alice", "misthalin");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, true);
  assert.strictEqual(Maps.cartographerCount("misthalin"), 1);
});

// --- drafting ---

test("draftMap rejects bad types and missing identity", () => {
  assert.strictEqual(Maps.draftMap("Alice", "misthalin", "nope").ok, false);
  assert.strictEqual(Maps.draftMap("", "misthalin", "city").ok, false);
});

test("draftMap creates a real map with deterministic quality", () => {
  const r = Maps.draftMap("Alice", "misthalin", "city");
  assert.strictEqual(r.ok, true);
  assert.ok(r.map.id);
  assert.strictEqual(r.map.type, "city");
  assert.ok(r.map.quality >= 1 && r.map.quality <= 10);
  assert.ok(r.map.value > 0);
});

test("dungeon maps honestly fail without real discoveries", () => {
  // No CitizenDiscovery stub injected and none on disk — must fail, never
  // invent geography.
  const r = Maps.draftMap("Alice", "misthalin", "dungeon");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-discovery");
});

// --- shop transactions ---

test("listMap + purchaseQuote + completePurchase flow", () => {
  const d = Maps.draftMap("Alice", "misthalin", "world");
  assert.strictEqual(d.ok, true);
  const l = Maps.listMap(d.map.id);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.price, d.map.value);
  const q = Maps.purchaseQuote(d.map.id);
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.price, d.map.value);
  assert.strictEqual(q.creator, "Alice");
  assert.strictEqual(q.creatorShare + q.shopShare, q.price);
  assert.strictEqual(q.creatorShare, Math.round(q.price * 0.7));
  const c = Maps.completePurchase(d.map.id, "Bob");
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.map.owner, "Bob");
  // No longer listed after purchase.
  assert.strictEqual(Maps.purchaseQuote(d.map.id).ok, false);
});

test("purchaseQuote fails for unlisted maps", () => {
  const d = Maps.draftMap("Alice", "misthalin", "city");
  assert.strictEqual(Maps.purchaseQuote(d.map.id).ok, false);
});

test("listingsFor is kingdom-scoped", () => {
  const a = Maps.draftMap("Alice", "misthalin", "city");
  const b = Maps.draftMap("Zara", "asgarnia", "city");
  Maps.listMap(a.map.id);
  Maps.listMap(b.map.id);
  const m = Maps.listingsFor("misthalin");
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].map.creator, "Alice");
});

// --- exploration logs ---

test("recordLog is honest about journeys", () => {
  assert.strictEqual(Maps.recordLog("", "a", "b").ok, false);
  const r = Maps.recordLog("Alice", "misthalin", "asgarnia", "ship");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(Maps.logsBy("alice").length, 1);
});

// --- treasure caches ---

test("unclaimedCaches is empty without treasure maps", () => {
  assert.deepStrictEqual(Maps.unclaimedCaches(), []);
});

// --- navigation bonus ---

test("mapNavigationBonusFor is zero with no maps", () => {
  assert.strictEqual(Maps.mapNavigationBonusFor("misthalin"), 0);
});

test("mapNavigationBonusFor grows with real maps and caps", () => {
  for (let i = 0; i < 20; i++) {
    const d = Maps.draftMap(`Carto${i}`, "misthalin", "world");
    assert.strictEqual(d.ok, true);
  }
  const bonus = Maps.mapNavigationBonusFor("misthalin");
  assert.ok(bonus > 0, "expected positive bonus");
  assert.ok(bonus <= 12, `bonus ${bonus} exceeds cap`);
});

// --- describe ---

test("describe returns shop summary for chat", () => {
  const d = Maps.draftMap("Alice", "misthalin", "city");
  Maps.listMap(d.map.id);
  const desc = Maps.describe("misthalin");
  assert.strictEqual(desc.mapCount, 1);
  assert.strictEqual(desc.listingCount, 1);
  assert.strictEqual(desc.cheapest, d.map.value);
  assert.strictEqual(desc.cartographerCount, 0); // not registered, just drafted
});

// --- persistence seams ---

test("save returns false when clean, resetForTests clears", () => {
  assert.strictEqual(Maps.save(), false);
  Maps.draftMap("Alice", "misthalin", "city");
  Maps.resetForTests();
  assert.strictEqual(Maps.describe("misthalin").mapCount, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
