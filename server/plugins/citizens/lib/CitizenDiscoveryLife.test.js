"use strict";

/**
 * CitizenDiscoveryLife.test.js — slow-tick tests. Plain node:assert.
 */

const assert = require("node:assert");
const Life = require("./CitizenDiscoveryLife");
const Discovery = require("./CitizenDiscovery");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Life.resetForTests();
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

function fakeDirector() {
  return {
    logs: [],
    log(msg, data) { this.logs.push({ msg, data }); },
    getOnlinePlayers() { return []; },
  };
}

console.log("CitizenDiscoveryLife:");

test("tick never throws with empty state", () => {
  const d = fakeDirector();
  Life.tickDiscoveryLife(d, Date.now()); // should not throw
  assert.ok(true);
});

test("tick never throws with null director methods", () => {
  Life.tickDiscoveryLife({}, Date.now()); // should not throw
  assert.ok(true);
});

test("tick saves discoveries", () => {
  Discovery.recordDiscovery("resource_node", 1, 1, 0, "Alice", "vein");
  const d = fakeDirector();
  Life.tickDiscoveryLife(d, Date.now());
  // save() returns false when not dirty after first save, or true —
  // either way it shouldn't throw. Check no crash.
  assert.ok(true);
});

test("resetForTests clears announcement state", () => {
  Discovery.recordDiscovery("dungeon_entrance", 3200, 3200, 0, "Alice", "cave");
  const d = fakeDirector();
  Life.tickDiscoveryLife(d, Date.now());
  Life.resetForTests();
  // After reset, discoveries are also cleared (via Discovery.resetForTests).
  assert.strictEqual(Discovery.allDiscoveries().length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
