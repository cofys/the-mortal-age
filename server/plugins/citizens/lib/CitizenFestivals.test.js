"use strict";
// CitizenFestivals unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  activeFestival,
  voiceOf,
  fillLine,
  pickOne,
  isRealPlayer,
  withinTiles,
  FESTIVALS,
  FESTIVAL_LINES,
  FESTIVAL_INVITES,
  _test,
} = require("./CitizenFestivals");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  _test.resetForTests();
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- Calendar ---
check("5 festivals defined", () => {
  assert.equal(FESTIVALS.length, 5);
  const ids = FESTIVALS.map((f) => f.id);
  assert.deepEqual(ids, [
    "founding-day",
    "springtide",
    "midsummer",
    "harvest-home",
    "embernight",
  ]);
});

check("festivals have unique months", () => {
  const months = FESTIVALS.map((f) => f.month);
  assert.equal(new Set(months).size, months.length);
});

check("activeFestival finds Founding Day on Jan 16", () => {
  const f = activeFestival(new Date(2026, 0, 16, 12).getTime());
  assert.ok(f);
  assert.equal(f.id, "founding-day");
});

check("activeFestival finds Embernight on Dec 22", () => {
  const f = activeFestival(new Date(2026, 11, 22, 12).getTime());
  assert.ok(f);
  assert.equal(f.id, "embernight");
});

check("activeFestival returns null outside festival windows", () => {
  assert.equal(activeFestival(new Date(2026, 2, 15, 12).getTime()), null);
  assert.equal(activeFestival(new Date(2026, 8, 1, 12).getTime()), null);
});

check("festival window is 3 days", () => {
  // startDay is included, startDay+3 is excluded
  const start = activeFestival(new Date(2026, 6, 1, 12).getTime());
  assert.ok(start && start.id === "midsummer");
  const lastDay = activeFestival(new Date(2026, 6, 3, 12).getTime());
  assert.ok(lastDay && lastDay.id === "midsummer");
  const after = activeFestival(new Date(2026, 6, 4, 12).getTime());
  assert.equal(after, null);
});

// --- Voice ---
check("cheerful citizen is excited", () => {
  assert.equal(voiceOf({ traits: ["cheerful"] }), "excited");
  assert.equal(voiceOf({ traits: ["devout"] }), "excited");
});

check("gruff citizen is grumbly", () => {
  assert.equal(voiceOf({ traits: ["gruff"] }), "grumbly");
  assert.equal(voiceOf({ traits: ["taciturn"] }), "grumbly");
});

check("plain citizen is mild", () => {
  assert.equal(voiceOf({ traits: ["methodical"] }), "mild");
  assert.equal(voiceOf({}), "mild");
  assert.equal(voiceOf(null), "mild");
});

// --- Lines ---
check("fillLine replaces {festival}", () => {
  const out = fillLine("Happy {festival}!", { name: "Harvest Home" });
  assert.equal(out, "Happy Harvest Home!");
});

check("every voice has lines and invites", () => {
  for (const voice of ["excited", "grumbly", "mild"]) {
    assert.ok(FESTIVAL_LINES[voice]?.length >= 3, `${voice} lines`);
    assert.ok(FESTIVAL_INVITES[voice]?.length >= 2, `${voice} invites`);
  }
});

check("pickOne is deterministic with seeded rng", () => {
  const a = pickOne(lcg(42), ["x", "y", "z"]);
  const b = pickOne(lcg(42), ["x", "y", "z"]);
  assert.equal(a, b);
  assert.ok(["x", "y", "z"].includes(a));
});

// --- Player/location helpers ---
check("isRealPlayer rejects bots and nulls", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot" }), false);
  assert.equal(
    isRealPlayer({ getUsername: () => "Liam" }),
    true
  );
});

check("withinTiles uses Chebyshev distance", () => {
  const loc = (x, y, z = 0) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });
  assert.equal(withinTiles(loc(0, 0), loc(10, 10), 14), true);
  assert.equal(withinTiles(loc(0, 0), loc(15, 0), 14), false);
  assert.equal(withinTiles(loc(0, 0, 0), loc(0, 0, 1), 14), false); // different plane
});

console.log(`\n${passed}/14 CitizenFestivals checks passed.`);
