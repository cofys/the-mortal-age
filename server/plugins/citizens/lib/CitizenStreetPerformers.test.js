// CitizenStreetPerformers unit test — pure helpers + stubbed-director integration.
// Run: node lib/CitizenStreetPerformers.test.js  (from server/plugins/citizens)
"use strict";
const assert = require("node:assert/strict");

const {
  performerTypeOf,
  spotFor,
  reputationOf,
  crowdChanceFor,
  isPerformanceHour,
  fillLine,
  pickOne,
  hashUsername,
  isRealPlayer,
  tickPerformers,
  tipPerformer,
  PERFORMER_TYPES,
  PERFORMER_MUSICIAN,
  PERFORMER_JUGGLER,
  PERFORMER_STORYTELLER,
  PERFORMER_MAGICIAN,
  REP_UNKNOWN,
  REP_LIKED,
  REP_POPULAR,
  REP_RENOWNED,
  PERFORMANCE_OPEN_HOUR,
  PERFORMANCE_CLOSE_HOUR,
  COINS_ID,
  TIP_MAX_COINS,
} = require("./CitizenStreetPerformers");

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
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- hashUsername ------------------------------------------------------------
check("hashUsername is deterministic", () => {
  assert.equal(hashUsername("Liam Cofy"), hashUsername("Liam Cofy"));
  assert.equal(hashUsername("Liam Cofy"), hashUsername("liam cofy")); // case-insensitive
  assert.notEqual(hashUsername("Alice"), hashUsername("Bob"));
});

// --- performerTypeOf ----------------------------------------------------------
check("performerTypeOf: non-commoners are never performers", () => {
  for (const role of ["guard", "merchant", "courtier", "refugee"]) {
    assert.equal(performerTypeOf({ username: "Some One", role }), null);
  }
});

check("performerTypeOf: null/empty records are safe", () => {
  assert.equal(performerTypeOf(null), null);
  assert.equal(performerTypeOf({}), null);
  assert.equal(performerTypeOf({ username: "", role: "commoner" }), null);
});

check("performerTypeOf: ~15% of commoners, valid types only", () => {
  let performers = 0;
  const total = 1000;
  for (let i = 0; i < total; i++) {
    const type = performerTypeOf({ username: `Commoner${i} Testname`, role: "commoner" });
    if (type !== null) {
      performers += 1;
      assert.ok(PERFORMER_TYPES.includes(type), `valid type: ${type}`);
    }
  }
  // Deterministic: same input always the same output.
  const t1 = performerTypeOf({ username: "Bardy McSong", role: "commoner" });
  const t2 = performerTypeOf({ username: "Bardy McSong", role: "commoner" });
  assert.equal(t1, t2);
  assert.ok(performers > 50 && performers < 250, `fraction sane: ${performers}/${total}`);
});

check("performerTypeOf: all four types occur", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = performerTypeOf({ username: `Citizen${i} Person`, role: "commoner" });
    if (t) seen.add(t);
  }
  for (const t of [PERFORMER_MUSICIAN, PERFORMER_JUGGLER, PERFORMER_STORYTELLER, PERFORMER_MAGICIAN]) {
    assert.ok(seen.has(t), `type occurs: ${t}`);
  }
});

// --- spotFor ------------------------------------------------------------------
check("spotFor: returns a spot near a known anchor kind", () => {
  const spot = spotFor({ username: "Bardy McSong", role: "commoner", kingdomId: "asgarnia" });
  assert.ok(spot, "spot exists");
  assert.ok(["square", "market", "tavern"].includes(spot.kind), `kind: ${spot.kind}`);
  assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.y), "tile coords");
});

check("spotFor: deterministic per citizen", () => {
  const a = spotFor({ username: "Bardy McSong", role: "commoner", kingdomId: "asgarnia" });
  const b = spotFor({ username: "Bardy McSong", role: "commoner", kingdomId: "asgarnia" });
  assert.deepEqual(a, b);
});

check("spotFor: null-safe", () => {
  assert.equal(spotFor(null), null);
  assert.equal(spotFor({}), null);
});

// --- reputation ----------------------------------------------------------------
check("reputationOf: tiers from applause count", () => {
  // Fresh module state: unknown citizen has no applause.
  assert.equal(reputationOf("Nobody Everheard"), REP_UNKNOWN);
});

check("crowdChanceFor: renowned draws the biggest crowd", () => {
  const u = crowdChanceFor(REP_UNKNOWN);
  const l = crowdChanceFor(REP_LIKED);
  const p = crowdChanceFor(REP_POPULAR);
  const r = crowdChanceFor(REP_RENOWNED);
  assert.ok(u < l && l < p && p < r, `ordering: ${u} < ${l} < ${p} < ${r}`);
  assert.ok(r <= 1 && u > 0, "valid probabilities");
});

// --- isPerformanceHour ----------------------------------------------------------
check("isPerformanceHour: 10:00-22:00 window", () => {
  const at = (h) => {
    const d = new Date(2026, 9, 7, h, 30, 0);
    return d.getTime();
  };
  assert.equal(isPerformanceHour(at(9)), false);
  assert.equal(isPerformanceHour(at(PERFORMANCE_OPEN_HOUR)), true);
  assert.equal(isPerformanceHour(at(15)), true);
  assert.equal(isPerformanceHour(at(PERFORMANCE_CLOSE_HOUR)), false);
  assert.equal(isPerformanceHour(at(23)), false);
});

// --- fillLine / pickOne ----------------------------------------------------------
check("fillLine replaces {tokens}", () => {
  assert.equal(fillLine("Hello {name}, {amount} coins!", { name: "Bob", amount: 50 }),
    "Hello Bob, 50 coins!");
  assert.equal(fillLine("No tokens here", {}), "No tokens here");
});

check("pickOne is deterministic with a seeded rng", () => {
  const arr = ["a", "b", "c", "d"];
  assert.equal(pickOne(lcg(42), arr), pickOne(lcg(42), arr));
});

// --- isRealPlayer -----------------------------------------------------------------
check("isRealPlayer gates bots and nulls", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({}), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getUsername: () => "RealHuman" }), true);
});

// --- tickPerformers: never throws --------------------------------------------------
check("tickPerformers: safe on empty/broken directors", () => {
  tickPerformers(null);
  tickPerformers({});
  tickPerformers({ roster: new Map() });
  // Off-hours: returns immediately, no iteration.
  const d = new Date(2026, 9, 7, 3, 0, 0).getTime();
  tickPerformers({ roster: new Map([["x", {}]]) }, d);
});

// --- tipPerformer ---------------------------------------------------------------------
function mockPlayer(username, coins) {
  return {
    getUsername: () => username,
    getInventory: () => ({
      getAmount: (id) => (id === COINS_ID ? coins : 0),
      deleteNumber: (id, n) => { mockPlayer._deleted = (mockPlayer._deleted ?? 0) + n; },
      refreshItems: () => {},
    }),
    sendMessage: (msg) => { mockPlayer._msgs.push(msg); },
  };
}
mockPlayer._msgs = [];
mockPlayer._deleted = 0;

function mockPerformerBot(username) {
  return {
    getUsername: () => username,
    getHostAddress: () => "bot",
    getInventory: () => ({ adds: () => {} }),
    forceChat: (line) => { mockPerformerBot._said.push(line); },
    performAnimation: () => {},
  };
}
mockPerformerBot._said = [];

check("tipPerformer: ignores non-coin items", () => {
  const event = {
    player: mockPlayer("Tipper", 1000),
    target: mockPerformerBot("Bardy McSong"),
    item: { getId: () => 1234, getAmount: () => 1 },
  };
  tipPerformer(event);
  assert.equal(event.handled, undefined);
});

check("tipPerformer: ignores tips to non-performers", () => {
  const event = {
    player: mockPlayer("Tipper", 1000),
    target: mockPerformerBot("Guardy McGuard"),
    item: { getId: () => COINS_ID, getAmount: () => 100 },
  };
  tipPerformer(event);
  // Not a performer (guards aren't commoners / hash gate) — event untouched.
  assert.equal(event.handled, undefined);
});

check("tipPerformer: real tip moves coins and thanks", () => {
  // Find a deterministic performer username.
  let performerName = null;
  let performerRecord = null;
  for (let i = 0; i < 500 && !performerName; i++) {
    const cand = `Busker${i} Tunes`;
    const rec = { username: cand, role: "commoner", kingdomId: "asgarnia" };
    if (performerTypeOf(rec)) {
      performerName = cand;
      performerRecord = rec;
    }
  }
  assert.ok(performerName, "found a deterministic performer");

  const { normalizeName } = require("./CitizenBonds");
  const stubDirector = {
    roster: new Map([[normalizeName(performerName), performerRecord]]),
    isOnline: () => true,
  };

  mockPlayer._msgs = [];
  mockPlayer._deleted = 0;
  mockPerformerBot._said = [];

  const event = {
    player: mockPlayer("GenerousTipper", 5000),
    target: mockPerformerBot(performerName),
    item: { getId: () => COINS_ID, getAmount: () => 500 },
  };
  tipPerformer(event, { director: stubDirector });
  assert.equal(event.handled, true, "tip handled");
  assert.equal(mockPlayer._deleted, 500, "500 coins removed");
  assert.ok(mockPerformerBot._said.length > 0, "performer thanked");
  assert.ok(
    mockPerformerBot._said[0].includes("GenerousTipper"),
    "thank-you names the tipper"
  );
  assert.ok(
    mockPlayer._msgs.some((m) => m.includes("500")),
    "player told the amount"
  );
});

check("tipPerformer: fat-finger guard caps at TIP_MAX_COINS", () => {
  let performerName = null;
  let performerRecord = null;
  for (let i = 0; i < 500 && !performerName; i++) {
    const cand = `Busker${i} Tunes`;
    const rec = { username: cand, role: "commoner", kingdomId: "asgarnia" };
    if (performerTypeOf(rec)) {
      performerName = cand;
      performerRecord = rec;
    }
  }
  const { normalizeName } = require("./CitizenBonds");
  const stubDirector = {
    roster: new Map([[normalizeName(performerName), performerRecord]]),
    isOnline: () => true,
  };
  mockPlayer._msgs = [];
  mockPlayer._deleted = 0;
  const event = {
    player: mockPlayer("Whale", 1000000),
    target: mockPerformerBot(performerName),
    item: { getId: () => COINS_ID, getAmount: () => 1000000 },
  };
  tipPerformer(event, { director: stubDirector });
  assert.equal(event.handled, true);
  assert.equal(mockPlayer._deleted, TIP_MAX_COINS, `capped at ${TIP_MAX_COINS}`);
  assert.ok(
    mockPlayer._msgs.some((m) => m.includes("capped")),
    "player told about the cap"
  );
});

check("tipPerformer: already-handled events are skipped", () => {
  const event = {
    handled: true,
    player: mockPlayer("Tipper", 1000),
    target: mockPerformerBot("Bardy McSong"),
    item: { getId: () => COINS_ID, getAmount: () => 100 },
  };
  tipPerformer(event); // must not throw, must not double-handle
});

console.log(`\nAll ${passed} CitizenStreetPerformers tests PASS`);
