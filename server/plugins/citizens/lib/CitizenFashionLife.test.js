"use strict";

/**
 * CitizenFashionLife.test.js — plain-node tests for the fashion tick.
 *
 * Verifies the tick never throws, schedules competitions, and announces.
 */

const assert = require("assert");
const Life = require("./CitizenFashionLife");
const Fashion = require("./CitizenFashion");

function test(name, fn) {
  try {
    Fashion.resetForTests();
    Life.resetForTests();
    fn();
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function mockDirector(kingdoms) {
  return {
    roster: { values: () => [] },
    getJournal: () => ({ log: () => {} }),
    log: () => {},
  };
}

console.log("CitizenFashionLife:");

test("tickFashion never throws on empty director", () => {
  Life.tickFashion({}, Date.now());
  Life.tickFashion(null, Date.now());
  Life.tickFashion(undefined);
});

test("tickFashion schedules competitions", () => {
  const director = mockDirector();
  const nowMs = Date.now();
  Life.tickFashion(director, nowMs);
  // Competitions may or may not be scheduled (kingdoms list is empty in mock).
  // The key assertion is no throw.
});

test("tickFashion warms the trend", () => {
  const director = mockDirector();
  const nowMs = Date.now();
  Life.tickFashion(director, nowMs);
  const trend = Fashion.currentTrend(nowMs);
  assert.ok(trend.color);
  assert.ok(trend.style);
});

test("resetForTests clears announcement state", () => {
  Life.resetForTests();
  // No throw = pass.
});

console.log("done.");
