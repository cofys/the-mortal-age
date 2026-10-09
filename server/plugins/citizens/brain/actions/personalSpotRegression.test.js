"use strict";

/**
 * Regression lock for the personalSpot arity bug (2026-10-09).
 *
 * humanizer.personalSpot's real signature is
 *   personalSpot(username, x, y, minR = 4, maxR = 10)
 * Several citizen actions called it as personalSpot(player, tile, 3) or even
 * personalSpot(player) / personalSpot(player, rngFn). With a player OBJECT as
 * the "username" and a tile OBJECT as "x", the math produced {x: NaN, y: NaN},
 * so the movement target was NaN and requestMovement silently no-op'd.
 *
 * These tests require the REAL humanizer (no stubs) and lock the contract:
 * the corrected call shapes used at every fixed call site return finite
 * numbers, and the removed buggy shapes demonstrably did not.
 *
 * Fixed call sites:
 *   CitizenCompete, CitizenEntertain, CitizenGuild, CitizenTeamPlay
 *     -> personalSpot(name, tile.x, tile.y, 3, 10)
 *   CitizenCelebrate, CitizenChefWork, CitizenTailorWork, CitizenPerform
 *     -> personalSpot(username, tile.x, tile.y, 2, 8)
 *   CitizenExplore (wildernessTile)
 *     -> personalSpot(username, home.x + dx, home.y + dy, 2, 8)
 */

const assert = require("assert");

const { personalSpot } = require("../../lib/humanizer");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function assertFiniteSpot(spot, label) {
  assert.ok(spot && typeof spot === "object", `${label}: returns an object`);
  assert.ok(Number.isFinite(spot.x), `${label}: x is finite (got ${spot.x})`);
  assert.ok(Number.isFinite(spot.y), `${label}: y is finite (got ${spot.y})`);
}

const VENUE = { x: 3200, y: 3200, z: 0 };
const PLAYER = { getUsername: () => "regtest", username: "regtest" };

// --- Corrected call shapes (what the fixed call sites now use) ---

test("venue walk shape personalSpot(name, tile.x, tile.y, 3, 10) is finite", () => {
  assertFiniteSpot(personalSpot("regtest", VENUE.x, VENUE.y, 3, 10), "venue shape");
});

test("homeTile shape personalSpot(username, tile.x, tile.y, 2, 8) is finite", () => {
  assertFiniteSpot(personalSpot("regtest", VENUE.x, VENUE.y, 2, 8), "homeTile shape");
});

test("explore wilderness shape personalSpot(username, x+dx, y+dy, 2, 8) is finite", () => {
  const spot = personalSpot("regtest", VENUE.x + 12, VENUE.y - 7, 2, 8);
  assertFiniteSpot(spot, "explore shape");
});

// --- Contract properties of the correct shape ---

test("personalSpot is deterministic per username", () => {
  const a = personalSpot("regtest", 3200, 3200, 3, 10);
  const b = personalSpot("regtest", 3200, 3200, 3, 10);
  assert.deepStrictEqual(a, b, "same inputs give the same spot");
});

test("personalSpot spreads citizens around the anchor (no stacking)", () => {
  const spots = new Set();
  for (let i = 0; i < 20; i++) {
    const s = personalSpot(`citizen-${i}`, 3200, 3200, 3, 10);
    assertFiniteSpot(s, `citizen-${i}`);
    // Ring bounds: dist from anchor within [minR, maxR].
    const d = Math.hypot(s.x - 3200, s.y - 3200);
    assert.ok(d >= 2 && d <= 11, `citizen-${i} within ring (dist ${d})`);
    spots.add(`${s.x},${s.y}`);
  }
  assert.ok(spots.size > 10, `20 citizens get ${spots.size} distinct spots`);
});

// --- The old buggy shapes (removed from every call site) ---

test("BUG SHAPE personalSpot(player) produced NaN", () => {
  const spot = personalSpot(PLAYER);
  assert.ok(Number.isNaN(spot.x) && Number.isNaN(spot.y),
    `expected NaN spot, got ${JSON.stringify(spot)}`);
});

test("BUG SHAPE personalSpot(player, tile, 3) produced NaN", () => {
  const spot = personalSpot(PLAYER, VENUE, 3);
  assert.ok(Number.isNaN(spot.x),
    `expected NaN x, got ${JSON.stringify(spot)}`);
});

test("BUG SHAPE personalSpot(player, rngFn) produced NaN", () => {
  const spot = personalSpot(PLAYER, Math.random);
  assert.ok(Number.isNaN(spot.x) && Number.isNaN(spot.y),
    `expected NaN spot, got ${JSON.stringify(spot)}`);
});

test("BUG SHAPE personalSpot(player, x, y, zAsMinR) was unpersonalized", () => {
  // Finite, but every citizen hashed from the same "[object Object]" seed —
  // the old CitizenExplore call was deterministic per TILE, not per citizen.
  const a = personalSpot({ username: "alice" }, 3212, 3193, 0);
  const b = personalSpot({ username: "bob" }, 3212, 3193, 0);
  assert.deepStrictEqual(a, b, "player-object seed ignores identity");
  const fixedA = personalSpot("alice", 3212, 3193, 2, 8);
  const fixedB = personalSpot("bob", 3212, 3193, 2, 8);
  assert.notDeepStrictEqual(fixedA, fixedB, "username seed personalizes");
});

console.log("\nAll personalSpot regression tests done.");
