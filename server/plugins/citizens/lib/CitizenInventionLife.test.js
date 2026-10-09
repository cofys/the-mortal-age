"use strict";

/**
 * CitizenInventionLife.test.js — slow-tick tests for invention dynamics.
 * Plain node:assert, no engine, no jest.
 */

const assert = require("node:assert");
const Inventions = require("./CitizenInventions");
const { tickInventionLife } = require("./CitizenInventionLife");

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

// Minimal director stub.
function mockDirector() {
  return {
    roster: new Map(),
    isOnline: () => false,
    getBot: () => null,
    log: () => {},
  };
}

console.log("CitizenInventionLife:");

test("tick advances active research projects", () => {
  const p = Inventions.startResearch("Alice", "improved_pickaxe");
  const before = p.progressTicks;
  tickInventionLife(mockDirector(), Date.now());
  const after = Inventions.activeProjects().find((x) => x.id === p.id);
  // Either advanced by 1, or completed (if it was a 1-tick blueprint — it's not).
  assert.ok(after, "project should still exist");
  assert.strictEqual(after.progressTicks, before + 1);
});

test("tick completes research and creates invention", () => {
  const p = Inventions.startResearch("Alice", "precision_chisel");
  const bp = Inventions.blueprint("precision_chisel");
  // Advance to one tick before completion.
  Inventions.progressResearch(p.id, bp.researchTicks - 1);
  assert.strictEqual(Inventions.allInventions().length, 0);
  tickInventionLife(mockDirector(), Date.now());
  assert.strictEqual(Inventions.allInventions().length, 1);
  const inv = Inventions.allInventions()[0];
  assert.strictEqual(inv.inventor, "Alice");
  assert.strictEqual(inv.blueprintId, "precision_chisel");
});

test("tick never throws with empty state", () => {
  tickInventionLife(mockDirector(), Date.now());
  // No assertion needed — just verify no throw.
  assert.ok(true);
});

test("tick never throws with broken director", () => {
  tickInventionLife({}, Date.now());
  tickInventionLife(null, Date.now());
  assert.ok(true);
});

test("completed invention gets a patent", () => {
  const p = Inventions.startResearch("Alice", "war_horn");
  const bp = Inventions.blueprint("war_horn");
  Inventions.progressResearch(p.id, bp.researchTicks - 1);
  tickInventionLife(mockDirector(), Date.now());
  const inv = Inventions.allInventions()[0];
  const patent = Inventions.patentFor(inv.id);
  assert.ok(patent);
  assert.strictEqual(patent.holder, "Alice");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
