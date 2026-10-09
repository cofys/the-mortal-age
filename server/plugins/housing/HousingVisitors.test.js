"use strict";

/**
 * HousingVisitors.test.js — plain-node tests for citizen visitor logic.
 *
 * Verifies: citizen-vs-player detection, capital proximity, room display
 * names, plot parsing, and the warming/admiration line templates.
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
    getLocation: () => ({ getX: () => 3210, getY: () => 3424 }),
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

test("citizensNear finds bots at the capital", () => {
  const citizens = [
    fakeMobile({ isPlayerBot: () => true }), // at Varrock (3210, 3424)
    fakeMobile({
      isPlayerBot: () => true,
      getLocation: () => ({ getX: () => 1000, getY: () => 1000 }),
    }),
  ];
  const players = { forEach: (fn) => citizens.forEach(fn) };
  const near = T.citizensNear(players, "misthalin");
  assert(near.length === 1, `one near Varrock, got ${near.length}`);
  assert(T.citizensNear(players, "nope").length === 0, "unknown capital -> none");
});

test("room display names", () => {
  assert(T.roomDisplayName("CHAPEL") === "chapel", "chapel");
  assert(T.roomDisplayName("THRONE_ROOM") === "throne room", "throne room");
  assert(T.roomDisplayName("WEIRD_ROOM") === "weird room", "fallback formats");
});

test("plotOf parses and tolerates", () => {
  const p = fakeMobile({
    getAttribute: () => JSON.stringify({ kingdomId: "misthalin" }),
  });
  assert(T.plotOf(p).kingdomId === "misthalin", "parses");
  assert(T.plotOf(fakeMobile()) === null, "missing -> null");
  assert(
    T.plotOf(fakeMobile({ getAttribute: () => "{bad" })) === null,
    "bad json -> null"
  );
});

test("capitals cover all five kingdoms", () => {
  for (const k of ["asgarnia", "misthalin", "kandarin", "morytania", "keldagrim"]) {
    assert(T.CAPITALS[k], `capital for ${k}`);
    assert(Number.isInteger(T.CAPITALS[k].x), `${k} x`);
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
