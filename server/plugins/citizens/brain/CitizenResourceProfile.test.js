"use strict";

/**
 * CitizenResourceProfile unit checks — kingdom resource-profile scoring.
 *
 * Grounded in server/plugins/economy/data/regional-resources.json (the
 * economy authority). Verifies the tie-breaker nudge: surplus wins ties,
 * deficit work stays legal, and unknown/missing inputs score neutrally.
 */

const assert = require("node:assert/strict");

const {
  profileWorkBonus,
  profileFor,
  resetForTests,
  SURPLUS_BONUS,
  DEFICIT_PENALTY,
} = require("./CitizenResourceProfile");

const failures = [];
function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL - ${name}: ${e.message}`);
  }
}

resetForTests();

// --- surplus bonuses ---------------------------------------------------------

run("keldagrim mining is surplus (+8)", () => {
  assert.equal(profileWorkBonus("keldagrim", "citizen_mine"), SURPLUS_BONUS);
});

run("kandarin woodcutting is surplus (+8)", () => {
  assert.equal(profileWorkBonus("kandarin", "citizen_chop"), SURPLUS_BONUS);
});

run("kandarin fishing is surplus (+8)", () => {
  assert.equal(profileWorkBonus("kandarin", "citizen_fish"), SURPLUS_BONUS);
});

run("morytania herb gathering is surplus (+8)", () => {
  assert.equal(profileWorkBonus("morytania", "citizen_herb"), SURPLUS_BONUS);
});

run("asgarnia farming is surplus (+8)", () => {
  assert.equal(profileWorkBonus("asgarnia", "citizen_farm"), SURPLUS_BONUS);
});

// --- deficit awareness (nudge, not a lock) ------------------------------------

run("kandarin mining is deficit (-4)", () => {
  assert.equal(profileWorkBonus("kandarin", "citizen_mine"), DEFICIT_PENALTY);
});

run("keldagrim woodcutting is deficit (-4)", () => {
  assert.equal(profileWorkBonus("keldagrim", "citizen_chop"), DEFICIT_PENALTY);
});

run("morytania mining is deficit (-4)", () => {
  assert.equal(profileWorkBonus("morytania", "citizen_mine"), DEFICIT_PENALTY);
});

run("misthalin fishing is deficit (-4, fish is a net import)", () => {
  assert.equal(profileWorkBonus("misthalin", "citizen_fish"), DEFICIT_PENALTY);
});

// --- magnitude is tie-breaker scale -------------------------------------------

run("bonus magnitude is sane (surplus 8, deficit -4)", () => {
  assert.equal(SURPLUS_BONUS, 8);
  assert.equal(DEFICIT_PENALTY, -4);
  assert.ok(SURPLUS_BONUS >= 5 && SURPLUS_BONUS <= 10, "surplus bonus in 5..10");
});

// --- neutral cases --------------------------------------------------------------

run("unknown kingdom scores 0", () => {
  assert.equal(profileWorkBonus("narnia", "citizen_mine"), 0);
});

run("unknown activity scores 0", () => {
  assert.equal(profileWorkBonus("keldagrim", "tavern_social"), 0);
});

run("missing inputs score 0", () => {
  assert.equal(profileWorkBonus(null, "citizen_mine"), 0);
  assert.equal(profileWorkBonus("keldagrim", null), 0);
  assert.equal(profileWorkBonus(), 0);
});

run("wilderness (contested, no region entry) scores 0", () => {
  assert.equal(profileWorkBonus("wilderness", "citizen_mine"), 0);
});

run("misthalin has no gather surplus — mining-neutral activities score 0", () => {
  // Misthalin's surplus is trade and animal products, not gatherables.
  assert.equal(profileWorkBonus("misthalin", "citizen_chop"), 0);
  assert.equal(profileWorkBonus("misthalin", "citizen_herb"), 0);
});

// --- authority is the JSON, not hardcoding --------------------------------------

run("profileFor reads the real economy JSON", () => {
  const keldagrim = profileFor("keldagrim");
  assert.ok(keldagrim, "keldagrim profile exists");
  assert.ok(keldagrim.surplus.includes("coal"), "coal surplus from JSON");
  assert.ok(keldagrim.deficit.includes("timber"), "timber deficit from JSON");
});

if (failures.length > 0) {
  console.log(`${failures.length} FAILURES: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("ALL CITIZENRESOURCEPROFILE TESTS DONE");
