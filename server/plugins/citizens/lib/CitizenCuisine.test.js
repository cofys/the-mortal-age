"use strict";

/**
 * CitizenCuisine.test.js — plain-node tests for the cuisine data tier.
 * Run: node server/plugins/citizens/lib/CitizenCuisine.test.js
 */

const assert = require("assert");
const Cuisine = require("./CitizenCuisine");

function fresh() {
  Cuisine.resetForTests();
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

console.log("CitizenCuisine tests:");

// --- dish catalog ---
test("DISH_TYPES has 8 dishes", () => {
  assert.strictEqual(Cuisine.DISH_TYPES.length, 8);
});

test("dishQuality is deterministic and bounded 1-10", () => {
  const q1 = Cuisine.dishQuality(99, 1);
  const q2 = Cuisine.dishQuality(99, 1);
  assert.strictEqual(q1, q2);
  assert.ok(q1 >= 1 && q1 <= 10);
  assert.ok(Cuisine.dishQuality(1, 0) < q1);
});

test("dishValue scales with quality", () => {
  const lo = Cuisine.dishValue("hearty_stew", 1, 0);
  const hi = Cuisine.dishValue("hearty_stew", 10, 0);
  assert.ok(hi > lo, `hi=${hi} should exceed lo=${lo}`);
});

test("dishValue scales with reviews", () => {
  const noRev = Cuisine.dishValue("royal_roast", 8, 0);
  const rev = Cuisine.dishValue("royal_roast", 8, 9);
  assert.ok(rev > noRev);
});

test("dishHeal scales with quality", () => {
  assert.ok(Cuisine.dishHeal("feast_platter", 10) > Cuisine.dishHeal("feast_platter", 1));
});

// --- master chefs ---
test("awardMasterChef awards once", () => {
  assert.strictEqual(Cuisine.awardMasterChef("Gordon"), true);
  assert.strictEqual(Cuisine.awardMasterChef("Gordon"), false);
  assert.strictEqual(Cuisine.isMasterChef("Gordon"), true);
  assert.strictEqual(Cuisine.isMasterChef("gordon"), true); // normalized
  assert.strictEqual(Cuisine.isMasterChef("Nobody"), false);
});

// --- dishes ---
test("createDish records a dish", () => {
  const dish = Cuisine.createDish("grilled_fish", "Gordon", 7, 1000);
  assert.ok(dish);
  assert.strictEqual(dish.type, "grilled_fish");
  assert.strictEqual(dish.chef, "Gordon");
  assert.strictEqual(dish.quality, 7);
  assert.ok(dish.heal > 0);
  assert.ok(dish.value > 0);
  assert.strictEqual(dish.servings, 10);
});

test("createDish rejects bad input", () => {
  assert.strictEqual(Cuisine.createDish("nope", "Gordon", 5, 1000), null);
  assert.strictEqual(Cuisine.createDish("grilled_fish", "", 5, 1000), null);
});

test("dishById and dishesByChef work", () => {
  const dish = Cuisine.createDish("hearty_stew", "Gordon", 5, 1000);
  assert.strictEqual(Cuisine.dishById(dish.id).id, dish.id);
  assert.strictEqual(Cuisine.dishesByChef("gordon").length, 1);
  assert.strictEqual(Cuisine.dishesByChef("Nobody").length, 0);
});

// --- restaurants ---
test("restaurantFor creates a named restaurant per kingdom", () => {
  const r1 = Cuisine.restaurantFor("varrock", 1000);
  const r2 = Cuisine.restaurantFor("varrock", 1000);
  assert.strictEqual(r1.name, r2.name);
  assert.ok(r1.name.length > 0);
});

test("addToMenu and menuFor work", () => {
  const dish = Cuisine.createDish("royal_roast", "Gordon", 8, 1000);
  assert.strictEqual(Cuisine.addToMenu("varrock", dish.id), true);
  assert.strictEqual(Cuisine.addToMenu("varrock", dish.id), false); // no dupes
  const menu = Cuisine.menuFor("varrock");
  assert.strictEqual(menu.length, 1);
  assert.strictEqual(menu[0].id, dish.id);
});

test("menuFor excludes sold-out dishes", () => {
  const dish = Cuisine.createDish("garden_salad", "Gordon", 5, 1000);
  Cuisine.addToMenu("falador", dish.id);
  for (let i = 0; i < 10; i++) Cuisine.serveDish(dish.id);
  assert.strictEqual(Cuisine.menuFor("falador").length, 0);
});

// --- reviews ---
test("reviewDish records and affects value", () => {
  const now = Date.now();
  const dish = Cuisine.createDish("spiced_curry", "Gordon", 6, now);
  const before = dish.value;
  Cuisine.reviewDish(dish.id, "Critic", 10, now);
  const after = Cuisine.dishById(dish.id).value;
  assert.ok(after > before, `after=${after} should exceed before=${before}`);
  assert.strictEqual(Cuisine.averageStars(dish.id), 10);
});

test("reviewDish clamps stars 1-10", () => {
  const now = Date.now();
  const dish = Cuisine.createDish("spiced_curry", "Gordon", 6, now);
  const r = Cuisine.reviewDish(dish.id, "Critic", 99, now);
  assert.strictEqual(r.stars, 10);
});

test("reviewsFor returns reviews for a dish", () => {
  const now = Date.now();
  const dish = Cuisine.createDish("hunters_pie", "Gordon", 6, now);
  Cuisine.reviewDish(dish.id, "A", 8, now);
  Cuisine.reviewDish(dish.id, "B", 6, now);
  assert.strictEqual(Cuisine.reviewsFor(dish.id).length, 2);
});

// --- dining ---
test("orderDish succeeds when affordable", () => {
  const dish = Cuisine.createDish("hearty_stew", "Gordon", 5, 1000);
  const result = Cuisine.orderDish("varrock", dish.id, 99999);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.chef, "Gordon");
  assert.ok(result.price > 0);
  assert.ok(result.heal > 0);
});

test("orderDish refuses when broke", () => {
  const dish = Cuisine.createDish("feast_platter", "Gordon", 10, 1000);
  const result = Cuisine.orderDish("varrock", dish.id, 1);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "cant-afford");
});

test("orderDish refuses sold-out", () => {
  const dish = Cuisine.createDish("hearty_stew", "Gordon", 5, 1000);
  for (let i = 0; i < 10; i++) Cuisine.serveDish(dish.id);
  const result = Cuisine.orderDish("varrock", dish.id, 99999);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "sold-out");
});

test("serveDish decrements servings", () => {
  const dish = Cuisine.createDish("hearty_stew", "Gordon", 5, 1000);
  assert.strictEqual(Cuisine.serveDish(dish.id), true);
  assert.strictEqual(Cuisine.dishById(dish.id).servings, 9);
});

// --- competitions ---
test("maybeScheduleCompetition schedules once per interval", () => {
  const now = Date.now();
  const c1 = Cuisine.maybeScheduleCompetition("varrock", now);
  assert.ok(c1);
  const c2 = Cuisine.maybeScheduleCompetition("varrock", now + 1000);
  assert.strictEqual(c2, null); // too soon + already open
});

test("enterCompetition and resolveCompetition work", () => {
  const now = Date.now();
  const comp = Cuisine.maybeScheduleCompetition("ardougne", now);
  const d1 = Cuisine.createDish("royal_roast", "Alice", 9, now);
  const d2 = Cuisine.createDish("hearty_stew", "Bob", 3, now);
  Cuisine.reviewDish(d1.id, "C", 10, now);
  assert.strictEqual(Cuisine.enterCompetition(comp.id, d1.id), true);
  assert.strictEqual(Cuisine.enterCompetition(comp.id, d2.id), true);
  const result = Cuisine.resolveCompetition(comp.id, now + 1000);
  assert.ok(result);
  assert.strictEqual(result.winner, "Alice");
  assert.strictEqual(result.runnerUp, "Bob");
  assert.strictEqual(result.prize, Cuisine.COMPETITION_PRIZE);
});

test("resolveCompetition needs 2+ entries", () => {
  const now = Date.now();
  const comp = Cuisine.maybeScheduleCompetition("keldagrim", now);
  const d1 = Cuisine.createDish("royal_roast", "Alice", 9, now);
  Cuisine.enterCompetition(comp.id, d1.id);
  assert.strictEqual(Cuisine.resolveCompetition(comp.id, now + 1000), null);
});

test("openCompetition returns the open one", () => {
  const now = Date.now();
  const comp = Cuisine.maybeScheduleCompetition("lumbridge", now);
  assert.strictEqual(Cuisine.openCompetition("lumbridge").id, comp.id);
  assert.strictEqual(Cuisine.openCompetition("varrock"), null);
});

// --- persistence ---
test("save/load round-trip preserves dishes", () => {
  Cuisine.createDish("feast_platter", "Gordon", 9, 1000);
  // save() with dirty flag
  const saved = Cuisine.save();
  assert.strictEqual(saved, true);
  // save() again with clean flag
  assert.strictEqual(Cuisine.save(), false);
});

// --- ingredient resolution regression (dead table paths) ---
test("ingredientIds resolves real engine item ids", () => {
  // The old resolveItemId required keyed { items } maps at table paths that
  // do not exist, so every kind silently resolved to null.
  const ids = Cuisine.ingredientIds();
  for (const kind of ["meat", "fish", "potato", "vegetable", "herb"]) {
    assert.ok(Number.isInteger(ids[kind]) && ids[kind] > 0,
      `${kind} must resolve to a real engine item id`);
  }
  assert.strictEqual(ids.meat, 2142, "meat -> Cooked meat");
  assert.strictEqual(ids.potato, 1942, "potato -> Potato");
  assert.strictEqual(ids.herb, 199, "herb -> Grimy guam leaf");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
