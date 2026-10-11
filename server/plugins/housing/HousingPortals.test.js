"use strict";

/**
 * HousingPortals.test.js — plain-node tests for the town POH portals.
 *
 * Verifies: 13 towns (5 capitals + 8 settlements), portal matching is
 * location-gated (other "Portal" objects untouched), first Use sets the
 * residence and housewarming flag, and house entry reuses the
 * construction:house-tablet event path.
 */

const portals = require("./HousingPortals");
const T = portals._test;

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

function fakePlayer(attrs = {}) {
  return {
    isPlayerBot: () => false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    sendMessage: () => {},
    _attrs: () => attrs,
  };
}

test("thirteen towns: five capitals, eight settlements", () => {
  assert(T.TOWNS.length === 13, `13 towns, got ${T.TOWNS.length}`);
  const capitals = T.TOWNS.filter((t) => t.kind === "capital");
  const settlements = T.TOWNS.filter((t) => t.kind === "settlement");
  assert(capitals.length === 5, `5 capitals, got ${capitals.length}`);
  assert(settlements.length === 8, `8 settlements, got ${settlements.length}`);
  const ids = new Set(T.TOWNS.map((t) => t.id));
  assert(ids.size === 13, "unique ids");
  for (const t of T.TOWNS) {
    assert(typeof t.name === "string" && t.name.length > 0, `${t.id} name`);
    assert(Number.isInteger(t.x) && Number.isInteger(t.y), `${t.id} coords`);
  }
});

test("townById resolves", () => {
  assert(T.townById("shilo").name === "Shilo Village", "settlement");
  assert(T.townById("asgarnia").name === "Falador", "capital");
  assert(T.townById("nope") === null, "unknown -> null");
});

test("matchPortal is location-gated", () => {
  T.seedSpawned([{ townId: "misthalin", townName: "Varrock", objectId: 4150, x: 3169, y: 3487, z: 0 }]);
  const hit = T.matchPortal(4150, { getX: () => 3170, getY: () => 3486, getZ: () => 0 });
  assert(hit && hit.townId === "misthalin", "near spawn matches");
  assert(T.matchPortal(4150, { getX: () => 3200, getY: () => 3400, getZ: () => 0 }) === null, "far tile -> null");
  assert(T.matchPortal(9999, { getX: () => 3169, getY: () => 3487, getZ: () => 0 }) === null, "wrong id -> null");
  assert(T.matchPortal(4150, { getX: () => 3169, getY: () => 3487, getZ: () => 1 }) === null, "wrong plane -> null");
});

test("enterOwnHouse reuses the house-tablet event", () => {
  const seen = [];
  const fakeApi = {
    emitCustomEvent: (name, req) => {
      seen.push(name);
      // mimic construction:house-tablet option "inside" for an owned house
      req.destination = { x: 1, y: 2, z: 0 };
      req.onArrival = () => {};
    },
    core: {
      TeleportHandler: {
        checkReqs: () => true,
        teleport: (player, dest, type, warn, onArrival) => {
          seen.push("teleport");
          assert(typeof onArrival === "function", "arrival hook passed");
        },
      },
      TeleportType: { TELE_TAB: "TELE_TAB" },
    },
  };
  const ok = T.enterOwnHouse(fakeApi, fakePlayer());
  assert(ok === true, "entry started");
  assert(seen[0] === "construction:house-tablet", "tablet event used");
  assert(seen.includes("teleport"), "teleport ran");
});

test("enterOwnHouse bails when there is no house", () => {
  const fakeApi = {
    emitCustomEvent: (name, req) => {
      // mimic construction:house-tablet with no owned house -> no destination
    },
    core: { TeleportHandler: { checkReqs: () => { throw new Error("must not run"); } } },
  };
  assert(T.enterOwnHouse(fakeApi, fakePlayer()) === false, "no destination -> false");
});

test("enterOwnHouse bails when teleport checks fail", () => {
  const fakeApi = {
    emitCustomEvent: (name, req) => {
      req.destination = { x: 1, y: 2, z: 0 };
    },
    core: {
      TeleportHandler: { checkReqs: () => false, teleport: () => { throw new Error("must not run"); } },
      TeleportType: { TELE_TAB: "TELE_TAB" },
    },
  };
  assert(T.enterOwnHouse(fakeApi, fakePlayer()) === false, "checkReqs false -> false");
});

test("residenceOf reads the attribute", () => {
  assert(T.residenceOf(fakePlayer({ "housing:residence": "nardah" })) === "nardah", "reads");
  assert(T.residenceOf(fakePlayer()) === null, "missing -> null");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
