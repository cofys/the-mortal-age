"use strict";

/**
 * StreetNotices.test.js — unit checks for the streets-notice module.
 *
 * Run: node StreetNotices.test.js  (from server/plugins/citizens)
 */

const assert = require("assert");
const {
  isMilestone,
  warmthOf,
  fillLine,
  LEVEL_LINES,
  MILESTONE_LINES,
  DEATH_LINES,
} = require("./StreetNotices");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check("milestones are the big levels", () => {
  for (const level of [10, 25, 50, 70, 90, 99]) assert.strictEqual(isMilestone(level), true, String(level));
  for (const level of [1, 2, 11, 30, 60, 98]) assert.strictEqual(isMilestone(level), false, String(level));
});

check("warmth reads traits and demeanor", () => {
  assert.strictEqual(warmthOf({ traits: ["cheerful"], demeanor: "loud" }), "warm");
  assert.strictEqual(warmthOf({ traits: ["gruff"], demeanor: "rough" }), "wry");
  assert.strictEqual(warmthOf({ traits: ["methodical"], demeanor: "calm" }), "neutral");
  assert.strictEqual(warmthOf({}), "neutral");
  assert.strictEqual(warmthOf(null), "neutral");
  assert.strictEqual(warmthOf({ traits: [], demeanor: "warm-hearted" }), "warm");
});

check("every line pool has a line per warmth, with the right slots", () => {
  for (const pool of [LEVEL_LINES, MILESTONE_LINES]) {
    for (const warmth of ["warm", "neutral", "wry"]) {
      const lines = pool[warmth];
      assert.ok(Array.isArray(lines) && lines.length >= 2, `pool.${warmth} too small`);
      for (const line of lines) {
        assert.ok(/\{level\}/.test(line) && /\{skill\}/.test(line), `missing slots in: ${line}`);
      }
    }
  }
  for (const warmth of ["warm", "neutral", "wry"]) {
    assert.ok(DEATH_LINES[warmth].length >= 2, `death.${warmth} too small`);
  }
});

check("fillLine substitutes slots", () => {
  assert.strictEqual(
    fillLine("Gz on {level} {skill}, {name}!", { name: "Jon", skill: "Woodcutting", level: 30 }),
    "Gz on 30 Woodcutting, Jon!"
  );
});

check("filled lines stay under the forceChat cap", () => {
  const longest = (pool) =>
    Math.max(...Object.values(pool).flat().map((l) => fillLine(l, { name: "Verylongplayername", skill: "Woodcutting", level: 99 }).length));
  assert.ok(longest(LEVEL_LINES) <= 120, `level line too long: ${longest(LEVEL_LINES)}`);
  assert.ok(longest(MILESTONE_LINES) <= 120, `milestone line too long: ${longest(MILESTONE_LINES)}`);
  assert.ok(longest(DEATH_LINES) <= 120, `death line too long: ${longest(DEATH_LINES)}`);
});

console.log(`\n${passed} checks passed.`);
