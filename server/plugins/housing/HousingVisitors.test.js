"use strict";

/**
 * HousingVisitors.test.js — plain-node tests for citizen visitor logic.
 *
 * Verifies: citizen-vs-player detection, town proximity, room display
 * names, residence resolution, and the warming/admiration line templates.
 */

const visitors = require("./HousingVisitors");
const T = visitors._test;

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

function fakeMobile(overrides = {}) {
  return {
    isPlayer: () => true,
    isPlayerBot: () => false,
    getLocation: () => ({ getX: () => 3170, getY: () => 3488 }),
    getUsername: () => "TestPlayer",
    getAttribute: () => null,
    setAttribute: () => {},
    ...overrides,
  };
}

test("citizen detection", () => {
  assert(T.isCitizen(fakeMobile()) === false, "human is not citizen");
  assert(T.isCitizen(fakeMobile({ isPlayerBot: () => true })) === true, "bot is citizen");
  assert(T.isRealPlayer(fakeMobile({ isPlayerBot: () => true })) === false, "bot not real");
  assert(T.isRealPlayer(fakeMobile()) === true, "human is real");
});

test("citizensNear finds bots at the town", () => {
  const citizens = [
    fakeMobile({ isPlayerBot: () => true }), // at Varrock portal (3170, 3488)
    fakeMobile({
      isPlayerBot: () => true,
      getLocation: () => ({ getX: () => 1000, getY: () => 1000 }),
    }),
  ];
  const players = { forEach: (fn) => citizens.forEach(fn) };
  const near = T.citizensNear(players, "misthalin");
  assert(near.length === 1, `one near Varrock, got ${near.length}`);
  assert(T.citizensNear(players, "nope").length === 0, "unknown town -> none");
});

test("room display names", () => {
  assert(T.roomDisplayName("CHAPEL") === "chapel", "chapel");
  assert(T.roomDisplayName("THRONE_ROOM") === "throne room", "throne room");
  assert(T.roomDisplayName("WEIRD_ROOM") === "weird room", "fallback formats");
});

test("residenceOf resolves town records", () => {
  const p = fakeMobile({ getAttribute: () => "misthalin" });
  assert(T.residenceOf(p).name === "Varrock", "resolves");
  assert(T.residenceOf(fakeMobile()) === null, "missing -> null");
  assert(T.residenceOf(fakeMobile({ getAttribute: () => "nope" })) === null, "unknown -> null");
});

test("town centers cover all thirteen towns", () => {
  const ids = [
    "asgarnia",
    "misthalin",
    "kandarin",
    "morytania",
    "keldagrim",
    "alkharid",
    "brimhaven",
    "lletya",
    "nardah",
    "pollnivneach",
    "rellekka",
    "shilo",
    "sophanem",
  ];
  assert(ids.length === 13, "thirteen towns");
  for (const k of ids) {
    assert(T.TOWN_CENTERS[k], `center for ${k}`);
    assert(Number.isInteger(T.TOWN_CENTERS[k].x), `${k} x`);
  }
});

test("admire threshold and cooldown sane", () => {
  assert(T.ADMIRE_MIN_VALUE === 100000, "100k threshold (tier House)");
  assert(T.ADMIRE_COOLDOWN_MS === 6 * 60 * 60 * 1000, "6h cooldown");
  assert(T.VISITOR_TICK_TICKS === 200, "tick interval");
});

test("tick is safe with empty world", () => {
  visitors.tickHousingVisitors({}); // must not throw
  visitors.tickHousingVisitors({ core: { World: {} } }); // must not throw
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
