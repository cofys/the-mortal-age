"use strict";

/**
 * house-value.test.js — plain-node tests for housing valuation.
 *
 * Verifies: room costs from real engine data, furniture XP proxy, tier
 * thresholds, hasRoom, showpieceRoom, and null-safety on malformed saves.
 */

const hv = require("./house-value");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    failed++;
    console.log("  FAIL -", name, ":", e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// A parlour (1000) + chapel (50000) with a crude wooden chair (58 xp -> 580)
// and an oak chair (120 xp -> 1200).
function makeSave() {
  return {
    rooms: [
      [
        [
          {
            roomKey: "PARLOUR",
            rotation: 0,
            furniture: { CHAIR_1: "CRUDE_WOODEN_CHAIR" },
          },
          {
            roomKey: "CHAPEL",
            rotation: 0,
            furniture: { CHAIR_1: "OAK_CHAIR" },
            furnitureByLocation: {
              "1:2:3": { buildableKey: "OAK_CHAIR", hotspotKey: "CHAIR_2" },
            },
          },
          null,
        ],
      ],
    ],
  };
}

test("room costs come from engine data", () => {
  assert(hv.roomValue("PARLOUR") === 1000, "parlour cost");
  assert(hv.roomValue("CHAPEL") === 50000, "chapel cost");
  assert(hv.roomValue("WORKSHOP") === 10000, "workshop cost");
  assert(hv.roomValue("KITCHEN") === 5000, "kitchen cost");
  assert(hv.roomValue("NOPE") === 0, "unknown room is 0");
});

test("furniture value uses XP proxy (x10)", () => {
  assert(hv.furnitureValue("CRUDE_WOODEN_CHAIR") === 580, "crude chair");
  assert(hv.furnitureValue("OAK_CHAIR") === 1200, "oak chair");
  assert(hv.furnitureValue("NOPE") === 0, "unknown buildable is 0");
});

test("valueHouse sums rooms + furniture", () => {
  const v = hv.valueHouse(makeSave());
  // rooms: 1000 + 50000; furniture: 580 + 1200 + 1200
  assert(v.value === 51000 + 2980, `got ${v.value}`);
  assert(v.roomCount === 2, "two rooms");
  assert(v.furnitureCount === 3, "three furniture pieces");
  assert(v.rooms.length === 2, "room detail list");
});

test("tier thresholds", () => {
  assert(hv.tierFor(0).key === "hovel", "0 -> hovel");
  assert(hv.tierFor(24999).key === "hovel", "24999 -> hovel");
  assert(hv.tierFor(25000).key === "cottage", "25000 -> cottage");
  assert(hv.tierFor(100000).key === "house", "100000 -> house");
  assert(hv.tierFor(500000).key === "manor", "500000 -> manor");
  assert(hv.tierFor(2000000).key === "palace", "2000000 -> palace");
  assert(hv.tierFor(99999999).key === "palace", "huge -> palace");
});

test("valueHouse tier matches value", () => {
  const v = hv.valueHouse(makeSave());
  assert(v.tier.key === "cottage", `got ${v.tier.key} for ${v.value}`);
});

test("hasRoom detects rooms", () => {
  const save = makeSave();
  assert(hv.hasRoom(save, "CHAPEL") === true, "chapel present");
  assert(hv.hasRoom(save, "WORKSHOP") === false, "workshop absent");
  assert(hv.hasRoom(null, "CHAPEL") === false, "null save safe");
});

test("showpieceRoom picks highest-cost room", () => {
  assert(hv.showpieceRoom(makeSave()) === "CHAPEL", "chapel is showpiece");
  assert(hv.showpieceRoom(null) === null, "null save safe");
  assert(hv.showpieceRoom({ rooms: [] }) === null, "empty save safe");
});

test("malformed saves never throw", () => {
  const v = hv.valueHouse({ rooms: "nope" });
  assert(v.value === 0 && v.roomCount === 0, "bad rooms shape");
  const v2 = hv.valueHouse({});
  assert(v2.value === 0, "missing rooms");
  const v3 = hv.valueHouse(null);
  assert(v3.value === 0, "null save");
});

test("oak outranks crude (quality tiers apply)", () => {
  assert(
    hv.furnitureValue("OAK_CHAIR") > hv.furnitureValue("CRUDE_WOODEN_CHAIR"),
    "oak chair worth more than crude"
  );
  assert(
    hv.furnitureValue("MAHOGANY_BOOKCASE") > hv.furnitureValue("OAK_BOOKCASE"),
    "mahogany bookcase worth more than oak"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
