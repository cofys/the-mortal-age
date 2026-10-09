"use strict";

/**
 * CitizenCuisineLife.test.js — plain-node tests for the cuisine slow tick.
 * Run: node server/plugins/citizens/lib/CitizenCuisineLife.test.js
 */

const assert = require("assert");
const Cuisine = require("./CitizenCuisine");
const Life = require("./CitizenCuisineLife");

function fresh() {
  Cuisine.resetForTests();
  Life.resetForTests();
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fresh();
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

// Minimal mock director.
function mockDirector(kingdoms, rosterRecords) {
  const log = [];
  return {
    kingdoms: kingdoms.map((id) => ({ id })),
    roster: { values: () => rosterRecords[Symbol.iterator]() },
    isOnline: () => false,
    getBot: () => null,
    getJournal: () => ({ log: (t) => log.push(t) }),
    log: (m, d) => log.push(m),
    _log: log,
  };
}

function citizen(name, kingdomId, opts = {}) {
  return {
    username: name,
    kingdomId,
    reputation: opts.reputation ?? 0,
    role: "commoner",
    ...opts,
  };
}

console.log("CitizenCuisineLife tests:");

test("tickCuisine never throws on empty director", () => {
  Life.tickCuisine(null, Date.now());
  Life.tickCuisine({}, Date.now());
  Life.tickCuisine({ roster: null }, Date.now());
});

test("tickCuisine schedules a competition per kingdom", () => {
  const now = Date.now();
  const director = mockDirector(["varrock", "falador"], []);
  Life.tickCuisine(director, now);
  assert.ok(Cuisine.openCompetition("varrock"), "varrock should have a competition");
  assert.ok(Cuisine.openCompetition("falador"), "falador should have a competition");
});

test("tickCuisine adds quality dishes to the menu", () => {
  const now = Date.now();
  Cuisine.createDish("royal_roast", "Gordon", 8, now);
  const director = mockDirector(["varrock"], []);
  Life.tickCuisine(director, now);
  const menu = Cuisine.menuFor("varrock");
  assert.ok(menu.length >= 1, "quality dish should be on the menu");
});

test("tickCuisine resolves an old competition with entries", () => {
  const now = Date.now();
  const old = now - 4 * 24 * 60 * 60 * 1000; // 4 days ago
  const comp = Cuisine.maybeScheduleCompetition("ardougne", old);
  assert.ok(comp, "competition should schedule");
  const d1 = Cuisine.createDish("feast_platter", "Alice", 9, old);
  const d2 = Cuisine.createDish("hearty_stew", "Bob", 4, old);
  Cuisine.enterCompetition(comp.id, d1.id);
  Cuisine.enterCompetition(comp.id, d2.id);
  const director = mockDirector(["ardougne"], []);
  Life.tickCuisine(director, now);
  const resolved = Cuisine.load().competitions.find((c) => c.id === comp.id);
  assert.ok(resolved.resolvedAt > 0, "competition should be resolved");
  assert.strictEqual(resolved.winner, "Alice");
});

test("tickCuisine never throws with bad roster records", () => {
  const now = Date.now();
  const director = mockDirector(["varrock"], [null, undefined, {}, { username: "x" }]);
  Life.tickCuisine(director, now);
});

test("critic review happens for eligible high-social citizens", () => {
  const now = Date.now();
  Cuisine.createDish("seafood_platter", "Gordon", 9, now);
  const critic = citizen("Foodie", "varrock", { reputation: 30 });
  const director = mockDirector(["varrock"], [critic]);
  Life.tickCuisine(director, now);
  const st = Cuisine.load();
  const dish = st.dishes[0];
  // Critic with reputation 30 -> social 80 >= 60, should review.
  assert.ok(Cuisine.reviewsFor(dish.id).length >= 1, "critic should have reviewed");
});

test("low-social citizens do not review", () => {
  const now = Date.now();
  Cuisine.createDish("seafood_platter", "Gordon", 9, now);
  const pleb = citizen("Pleb", "varrock", { reputation: -50 });
  const director = mockDirector(["varrock"], [pleb]);
  Life.tickCuisine(director, now);
  const dish = Cuisine.load().dishes[0];
  assert.strictEqual(Cuisine.reviewsFor(dish.id).length, 0, "low-social should not review");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
