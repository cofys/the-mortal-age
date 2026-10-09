"use strict";

/**
 * CitizenInventions.test.js — data-tier tests for the invention registry.
 * Plain node:assert, no engine, no jest.
 */

const assert = require("node:assert");
const Inventions = require("./CitizenInventions");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Inventions.resetForTests();
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

console.log("CitizenInventions:");

// --- blueprints ---

test("blueprints returns the frozen catalog", () => {
  const bps = Inventions.blueprints();
  assert.ok(bps.improved_pickaxe);
  assert.ok(bps.siege_ram_plans);
  assert.strictEqual(bps.war_horn.military, true);
  assert.strictEqual(bps.improved_pickaxe.military, undefined);
});

test("blueprint returns null for unknown id", () => {
  assert.strictEqual(Inventions.blueprint("bogus"), null);
});

test("blueprint materials use real item ids", () => {
  const bp = Inventions.blueprint("improved_pickaxe");
  assert.ok(bp.materials[2351] === 2); // iron bar
  assert.ok(bp.materials[8778] === 1); // oak planks
});

// --- research projects ---

test("startResearch creates a project", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  assert.ok(p.id.startsWith("proj-"));
  assert.strictEqual(p.inventor, "Alice");
  assert.strictEqual(p.blueprintId, "improved_pickaxe");
  assert.strictEqual(p.progressTicks, 0);
});

test("startResearch rejects unknown blueprint", () => {
  assert.strictEqual(Inventions.startResearch("Alice", "bogus"), null);
});

test("activeProjects lists all", () => {
  Inventions.startResearch("Alice", "improved_pickaxe");
  Inventions.startResearch("Bob", "war_horn");
  assert.strictEqual(Inventions.activeProjects().length, 2);
});

test("projectsFor filters by inventor", () => {
  Inventions.startResearch("Alice", "improved_pickaxe");
  Inventions.startResearch("Bob", "war_horn");
  const alice = Inventions.projectsFor("Alice");
  assert.strictEqual(alice.length, 1);
  assert.strictEqual(alice[0].inventor, "Alice");
});

test("progressResearch advances ticks", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const updated = Inventions.progressResearch(p.id, 5);
  assert.strictEqual(updated.progressTicks, 5);
  // Still a project, not an invention.
  assert.ok(updated.id.startsWith("proj-"));
});

test("progressResearch completes into an invention", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const bp = Inventions.blueprint("improved_pickaxe");
  const result = Inventions.progressResearch(p.id, bp.researchTicks);
  // Should be an invention now (has label, no progressTicks).
  assert.ok(result.label);
  assert.strictEqual(result.inventor, "Alice");
  assert.strictEqual(result.blueprintId, "improved_pickaxe");
  // Project should be gone.
  assert.strictEqual(Inventions.projectsFor("Alice").length, 0);
});

test("progressResearch returns null for unknown project", () => {
  assert.strictEqual(Inventions.progressResearch("proj-bogus", 1), null);
});

test("cancelResearch removes the project", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  assert.strictEqual(Inventions.cancelResearch(p.id), true);
  assert.strictEqual(Inventions.activeProjects().length, 0);
});

test("cancelResearch returns false for unknown project", () => {
  assert.strictEqual(Inventions.cancelResearch("proj-bogus"), false);
});

// --- inventions ---

test("allInventions lists completed", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const bp = Inventions.blueprint("improved_pickaxe");
  Inventions.progressResearch(p.id, bp.researchTicks);
  assert.strictEqual(Inventions.allInventions().length, 1);
});

test("inventionsFor filters by inventor", () => {
  const p1 = Inventions.startResearch("Alice", "improved_pickaxe");
  const p2 = Inventions.startResearch("Bob", "war_horn");
  Inventions.progressResearch(p1.id, Inventions.blueprint("improved_pickaxe").researchTicks);
  Inventions.progressResearch(p2.id, Inventions.blueprint("war_horn").researchTicks);
  assert.strictEqual(Inventions.inventionsFor("Alice").length, 1);
  assert.strictEqual(Inventions.inventionsFor("Bob").length, 1);
});

test("invention returns null for unknown id", () => {
  assert.strictEqual(Inventions.invention("inv-bogus"), null);
});

// --- patents ---

test("completed invention auto-grants patent to inventor", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const bp = Inventions.blueprint("improved_pickaxe");
  const inv = Inventions.progressResearch(p.id, bp.researchTicks);
  const patent = Inventions.patentFor(inv.id);
  assert.ok(patent);
  assert.strictEqual(patent.holder, "Alice");
});

test("licenseInvention charges royalty to patent holder", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const bp = Inventions.blueprint("improved_pickaxe");
  const inv = Inventions.progressResearch(p.id, bp.researchTicks);
  const result = Inventions.licenseInvention(inv.id, "Bob");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.royaltyPaid, Inventions.ROYALTY_COINS);
  assert.strictEqual(result.patentHolder, "Alice");
});

test("licenseInvention is free for the patent holder", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const bp = Inventions.blueprint("improved_pickaxe");
  const inv = Inventions.progressResearch(p.id, bp.researchTicks);
  const result = Inventions.licenseInvention(inv.id, "Alice");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.royaltyPaid, 0);
  assert.strictEqual(result.selfLicensed, true);
});

test("licenseInvention returns false for unknown invention", () => {
  const result = Inventions.licenseInvention("inv-bogus", "Bob");
  assert.strictEqual(result.ok, false);
});

// --- workshops ---

test("workshopTile returns null when site module unavailable", () => {
  // In plain-node test env, CitizenSites may not load. Should not throw.
  const tile = Inventions.workshopTile("asgarnia");
  // Either a tile or null — just verify no throw.
  assert.ok(tile === null || (typeof tile.x === "number" && typeof tile.y === "number"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
