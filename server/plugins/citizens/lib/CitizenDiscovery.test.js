"use strict";

/**
 * CitizenDiscovery.test.js — data-tier tests for the discovery registry.
 * Plain node:assert, no engine, no jest.
 */

const assert = require("node:assert");
const Discovery = require("./CitizenDiscovery");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Discovery.resetForTests();
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

console.log("CitizenDiscovery:");

test("recordDiscovery creates a discovery with an id", () => {
  const d = Discovery.recordDiscovery("resource_node", 3200, 3200, 0, "Alice", "old copper vein");
  assert.ok(d.id.startsWith("disc-"));
  assert.strictEqual(d.type, "resource_node");
  assert.strictEqual(d.discoverer, "Alice");
  assert.strictEqual(d.x, 3200);
});

test("recordDiscovery rejects unknown types", () => {
  const d = Discovery.recordDiscovery("bogus_type", 0, 0, 0, "Bob", "x");
  assert.strictEqual(d, null);
});

test("allDiscoveries returns all recorded", () => {
  Discovery.recordDiscovery("ancient_ruin", 1, 1, 0, "Alice", "ruin");
  Discovery.recordDiscovery("dungeon_entrance", 2, 2, 0, "Bob", "dungeon");
  assert.strictEqual(Discovery.allDiscoveries().length, 2);
});

test("discoveriesOfType filters by type", () => {
  Discovery.recordDiscovery("ancient_ruin", 1, 1, 0, "Alice", "ruin");
  Discovery.recordDiscovery("dungeon_entrance", 2, 2, 0, "Bob", "dungeon");
  const ruins = Discovery.discoveriesOfType("ancient_ruin");
  assert.strictEqual(ruins.length, 1);
  assert.strictEqual(ruins[0].type, "ancient_ruin");
});

test("claimDiscovery claims for a kingdom", () => {
  const d = Discovery.recordDiscovery("resource_node", 3200, 3200, 0, "Alice", "vein");
  assert.strictEqual(Discovery.claimDiscovery(d.id, "varrock"), true);
  const all = Discovery.allDiscoveries();
  assert.strictEqual(all[0].claimedBy, "varrock");
});

test("claimDiscovery fails on already-claimed", () => {
  const d = Discovery.recordDiscovery("resource_node", 3200, 3200, 0, "Alice", "vein");
  Discovery.claimDiscovery(d.id, "varrock");
  assert.strictEqual(Discovery.claimDiscovery(d.id, "falador"), false);
});

test("claimableNear finds unclaimed within radius", () => {
  Discovery.recordDiscovery("resource_node", 3200, 3200, 0, "Alice", "near");
  Discovery.recordDiscovery("resource_node", 9999, 9999, 0, "Bob", "far");
  const near = Discovery.claimableNear(3200, 3200, "varrock");
  assert.strictEqual(near.length, 1);
  assert.strictEqual(near[0].name, "near");
});

test("markMapped records the cartographer", () => {
  const d = Discovery.recordDiscovery("ancient_ruin", 1, 1, 0, "Alice", "ruin");
  assert.strictEqual(Discovery.markMapped(d.id, "Carto"), true);
  assert.strictEqual(Discovery.allDiscoveries()[0].mappedBy, "Carto");
});

test("unmappedDiscoveries excludes mapped", () => {
  const d1 = Discovery.recordDiscovery("ancient_ruin", 1, 1, 0, "Alice", "r1");
  Discovery.recordDiscovery("ancient_ruin", 2, 2, 0, "Bob", "r2");
  Discovery.markMapped(d1.id, "Carto");
  assert.strictEqual(Discovery.unmappedDiscoveries().length, 1);
});

test("trade route adoption lifecycle", () => {
  const d = Discovery.recordDiscovery("trade_route", 1, 1, 0, "Alice", "path");
  assert.strictEqual(Discovery.unadoptedTradeRoutes().length, 1);
  assert.strictEqual(Discovery.markTradeRouteAdopted(d.id), true);
  assert.strictEqual(Discovery.unadoptedTradeRoutes().length, 0);
});

test("markTradeRouteAdopted rejects non-routes", () => {
  const d = Discovery.recordDiscovery("ancient_ruin", 1, 1, 0, "Alice", "ruin");
  assert.strictEqual(Discovery.markTradeRouteAdopted(d.id), false);
});

test("fameForDiscovery returns type fame", () => {
  assert.strictEqual(Discovery.fameForDiscovery("dungeon_entrance"), 8);
  assert.strictEqual(Discovery.fameForDiscovery("resource_node"), 3);
  assert.strictEqual(Discovery.fameForDiscovery("bogus"), 0);
});

test("DISCOVERY_TYPES has all five types", () => {
  const types = Object.keys(Discovery.DISCOVERY_TYPES);
  assert.ok(types.includes("resource_node"));
  assert.ok(types.includes("dungeon_entrance"));
  assert.ok(types.includes("trade_route"));
  assert.ok(types.includes("ancient_ruin"));
  assert.ok(types.includes("monster_lair"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
