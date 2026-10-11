"use strict";

/**
 * BankRobbery.plugin — unit tests for the pure helpers.
 *
 * Covers: tier geography, Thieving success curve, the 100k + 25%-of-take
 * auto-bounty math, notoriety titles, and heat level/expiry. The live
 * handlers (casing, breach, crack, chase, jail) need the engine; they are
 * exercised through the agent MCP test path instead.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const plugin = require("./BankRobbery.plugin");
const T = plugin._test;

describe("bank-robbery geography", () => {
  it("tiers banks by distance to the nearest capital", () => {
    // Misthalin capital (3165, 3485).
    assert.equal(T.tierFor(3165, 3485), "capital");
    assert.equal(T.tierFor(3165 + 100, 3485), "city");
    assert.equal(T.tierFor(3165 + 400, 3485), "village");
  });

  it("maps every bank to the nearest capital's court", () => {
    assert.equal(T.kingdomFor(3165, 3485), "misthalin");
    assert.equal(T.kingdomFor(2964, 3378), "asgarnia");
  });

  it("keys a bank by its tile", () => {
    assert.equal(T.bankKey(3165.4, 3485.6), "3165_3486");
  });
});

describe("thieving rolls", () => {
  it("floors at 15% and caps at 95%", () => {
    assert.equal(T.thieveChance(1, 90), 0.15);
    assert.equal(T.thieveChance(99, 1), 0.95);
  });

  it("scales +3% per level above difficulty", () => {
    const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ~= ${b}`);
    // At the requirement itself: 15%.
    approx(T.thieveChance(40, 40), 0.15);
    // Ten levels over: 15% + 30% = 45%.
    approx(T.thieveChance(50, 40), 0.45);
  });
});

describe("consequences", () => {
  it("auto-bounty is 100k + 25% of the take", () => {
    assert.equal(T.bountyFor(0), 100000);
    assert.equal(T.bountyFor(400000), 200000);
    assert.equal(T.bountyFor(3000000), 850000);
  });

  it("titles notoriety: Suspect, Outlaw, Murderer", () => {
    assert.equal(T.notorietyTitle(0), "Clean");
    assert.equal(T.notorietyTitle(1), "Suspect");
    assert.equal(T.notorietyTitle(4), "Suspect");
    assert.equal(T.notorietyTitle(5), "Outlaw");
    assert.equal(T.notorietyTitle(9), "Outlaw");
    assert.equal(T.notorietyTitle(10), "Murderer");
  });

  it("heat expires after a week and stacks to MAX_HEAT", () => {
    const now = Date.now();
    const d = { heat: { asgarnia: { level: 2, until: now + 1000 } } };
    assert.equal(T.heatLevelOf(d, "asgarnia", now), 2);
    assert.equal(T.heatLevelOf(d, "asgarnia", now + 8 * 24 * 3600 * 1000), 0);
    assert.equal(T.heatLevelOf(d, "misthalin", now), 0);
  });
});

describe("tier config", () => {
  it("loot bands match the design (50-150k / 300-800k / 1-3M)", () => {
    assert.deepEqual(
      [T.TIERS.village.lootMin, T.TIERS.village.lootMax],
      [50000, 150000]
    );
    assert.deepEqual([T.TIERS.city.lootMin, T.TIERS.city.lootMax], [300000, 800000]);
    assert.deepEqual(
      [T.TIERS.capital.lootMin, T.TIERS.capital.lootMax],
      [1000000, 3000000]
    );
  });

  it("thieving requirements gate the tiers (40 / 65 / 85)", () => {
    assert.deepEqual(
      [T.TIERS.village.reqThief, T.TIERS.city.reqThief, T.TIERS.capital.reqThief],
      [40, 65, 85]
    );
  });
});
