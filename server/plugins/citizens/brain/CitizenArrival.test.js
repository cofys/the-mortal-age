"use strict";

/**
 * CitizenArrival.test — brain-side arrival behavior (whereabouts slice 2).
 * Plain node: `node brain/CitizenArrival.test.js` from the citizens dir.
 *
 * Verifies arrivalActivityFor maps slice-1 arrival markers to the matching
 * activity, yields to the needs engine for hurt/weary citizens, and ignores
 * stale, far, or missing markers.
 */

const assert = require("assert");
const {
  arrivalActivityFor,
  ARRIVAL_FRESH_MS,
  ARRIVAL_NEAR_TILES,
} = require("./CitizenArrival");
const {
  ACT_CHOP,
  ACT_MINE,
  ACT_FISH,
  ACT_SOCIAL,
  ACT_BANK,
} = require("./CitizenDecisions");
const { ensureNeeds, HURT_AT, WEARY_AT } = require("./CitizenNeeds");

const NOW = new Date(2026, 9, 13, 14, 0, 0).getTime();

function record(name, kind, overrides = {}) {
  return {
    username: name,
    position: { x: 3250, y: 3200, z: 0 },
    arrived: {
      kind,
      placeId: `test:${kind}`,
      x: 3250,
      y: 3200,
      z: 0,
      at: NOW,
    },
    ...overrides,
  };
}

// 1-6. Kind mapping: gather places -> gather activities, hubs -> social,
// bank -> bank, home -> nothing (needs engine owns resters).
assert.strictEqual(arrivalActivityFor(record("A1", "tree"), NOW), ACT_CHOP);
assert.strictEqual(arrivalActivityFor(record("A2", "rock"), NOW), ACT_MINE);
assert.strictEqual(arrivalActivityFor(record("A3", "fish"), NOW), ACT_FISH);
assert.strictEqual(arrivalActivityFor(record("A4", "square"), NOW), ACT_SOCIAL);
assert.strictEqual(arrivalActivityFor(record("A5", "market"), NOW), ACT_SOCIAL);
assert.strictEqual(arrivalActivityFor(record("A6", "bank"), NOW), ACT_BANK);
assert.strictEqual(arrivalActivityFor(record("A7", "home"), NOW), null);
assert.strictEqual(arrivalActivityFor(record("A8", "mystery"), NOW), null);
console.log("ok 1 — kind mapping: tree/rock/fish/square/market/bank; home/unknown -> null");

// 7. No marker at all -> null (normal picker owns them).
assert.strictEqual(
  arrivalActivityFor({ username: "A9", position: { x: 1, y: 1, z: 0 } }, NOW),
  null
);
console.log("ok 2 — no arrival marker -> null");

// 8. Hurt citizen: needs utility wins, no seed.
{
  const needs = ensureNeeds("ArrivalHurt");
  needs.hp = HURT_AT - 1;
  assert.strictEqual(
    arrivalActivityFor(record("ArrivalHurt", "tree"), NOW),
    null,
    "hurt citizen must not be seeded"
  );
  needs.hp = 100;
  console.log("ok 3 — hurt citizen -> null (needs engine wins)");
}

// 9. Weary citizen: needs utility wins, no seed.
{
  const needs = ensureNeeds("ArrivalWeary");
  needs.energy = WEARY_AT - 1;
  assert.strictEqual(
    arrivalActivityFor(record("ArrivalWeary", "rock"), NOW),
    null,
    "weary citizen must not be seeded"
  );
  needs.energy = 100;
  console.log("ok 4 — weary citizen -> null (needs engine wins)");
}

// 10. Stale marker (> ARRIVAL_FRESH_MS): they've been standing around.
assert.strictEqual(
  arrivalActivityFor(
    record("A10", "tree", {
      arrived: { kind: "tree", x: 3250, y: 3200, z: 0, at: NOW - ARRIVAL_FRESH_MS - 1 },
    }),
    NOW
  ),
  null
);
console.log("ok 5 — stale arrival -> null");

// 11. Far from the arrival tile: passed through, not still there.
assert.strictEqual(
  arrivalActivityFor(
    record("A11", "tree", { position: { x: 3250 + ARRIVAL_NEAR_TILES + 1, y: 3200, z: 0 } }),
    NOW
  ),
  null
);
console.log("ok 6 — far from arrival tile -> null");

// 12. Boundary: exactly ARRIVAL_NEAR_TILES away still counts (<= radius).
assert.strictEqual(
  arrivalActivityFor(
    record("A12", "fish", { position: { x: 3250 + ARRIVAL_NEAR_TILES, y: 3200, z: 0 } }),
    NOW
  ),
  ACT_FISH
);
console.log("ok 7 — at the near boundary still seeds");

// 13. Different plane -> null.
assert.strictEqual(
  arrivalActivityFor(
    record("A13", "square", { position: { x: 3250, y: 3200, z: 1 } }),
    NOW
  ),
  null
);
console.log("ok 8 — different plane -> null");

// 14. Broken inputs never throw.
assert.strictEqual(arrivalActivityFor(null, NOW), null);
assert.strictEqual(arrivalActivityFor({}, NOW), null);
assert.strictEqual(arrivalActivityFor({ username: "A14" }, NOW), null);
console.log("ok 9 — broken inputs -> null, never throws");

console.log("all CitizenArrival tests passed");
