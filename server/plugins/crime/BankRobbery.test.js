"use strict";

/**
 * BankRobbery.plugin — the crime endgame.
 *
 * Covers the pure heist math: tier geography, Thieving success chances,
 * the auto-bounty formula (100k + 25% of take), notoriety titles, heat
 * levels, and bank/cooldown keying. All engine-touching behavior is
 * exercised through these same helpers in production.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const T = require("./BankRobbery.plugin")._test;

describe("bank robbery tiers", () => {
  it("at a capital doorstep is a capital vault", () => {
    // Asgarnia capital at (2964, 3378).
    assert.equal(T.tierFor(2964, 3378), "capital");
    assert.equal(T.tierFor(2970, 3385), "capital");
  });

  it("a hundred tiles out is a city bank", () => {
    assert.equal(T.tierFor(2964, 3278), "city");
  });

  it("far from any capital is a village bank", () => {
    assert.equal(T.tierFor(2600, 3000), "village");
  });

  it("tiers carry the design's requirements and loot bands", () => {
    assert.equal(T.TIERS.village.reqThief, 40);
    assert.equal(T.TIERS.city.reqThief, 65);
    assert.equal(T.TIERS.capital.reqThief, 85);
    assert.deepEqual(
      [T.TIERS.village.lootMin, T.TIERS.village.lootMax],
      [50000, 150000]
    );
    assert.deepEqual(
      [T.TIERS.capital.lootMin, T.TIERS.capital.lootMax],
      [1000000, 3000000]
    );
  });
});

describe("bank robbery kingdoms", () => {
  it("the hit kingdom is the nearest capital", () => {
    assert.equal(T.kingdomFor(2964, 3378), "asgarnia");
    assert.equal(T.kingdomFor(3165, 3485), "misthalin");
  });

  it("bank keys are stable coordinate strings", () => {
    assert.equal(T.bankKey(3007.4, 3322.6), "3007_3323");
    assert.equal(T.bankKey(3007.4, 3322.6), T.bankKey(3007, 3323));
  });
});

describe("thieving chances", () => {
  it("floors at 15% when under-leveled", () => {
    assert.equal(T.thieveChance(1, 90), 0.15);
    assert.equal(T.thieveChance(40, 90), 0.15);
  });

  it("is 15% exactly at the difficulty", () => {
    assert.equal(T.thieveChance(70, 70), 0.15);
  });

  it("scales 3% per level above difficulty", () => {
    assert.ok(Math.abs(T.thieveChance(80, 70) - 0.45) < 1e-9);
  });

  it("caps at 95%", () => {
    assert.equal(T.thieveChance(99, 50), 0.95);
    assert.equal(T.thieveChance(99, 70), 0.95);
    assert.ok(T.thieveChance(99, 90) < 0.95, "nine levels over is not yet capped");
  });
});

describe("auto-bounty formula", () => {
  it("is 100k + 25% of the take", () => {
    assert.equal(T.bountyFor(0), 100000);
    assert.equal(T.bountyFor(400000), 200000);
    assert.equal(T.bountyFor(2800000), 800000);
  });

  it("never goes negative on a zero take", () => {
    assert.equal(T.bountyFor(-50), 100000);
  });
});

describe("notoriety titles", () => {
  it("walks the Clean -> Suspect -> Outlaw -> Murderer ladder", () => {
    assert.equal(T.notorietyTitle(0), "Clean");
    assert.equal(T.notorietyTitle(1), "Suspect");
    assert.equal(T.notorietyTitle(4), "Suspect");
    assert.equal(T.notorietyTitle(5), "Outlaw");
    assert.equal(T.notorietyTitle(9), "Outlaw");
    assert.equal(T.notorietyTitle(10), "Murderer");
    assert.equal(T.notorietyTitle(25), "Murderer");
  });
});

describe("kingdom heat", () => {
  it("is zero with no heat record", () => {
    assert.equal(T.heatLevelOf({ heat: {} }, "asgarnia", 1000), 0);
    assert.equal(T.heatLevelOf({}, "asgarnia", 1000), 0);
  });

  it("reads the live level and expires on time", () => {
    const now = 1_000_000;
    const data = { heat: { asgarnia: { level: 2, until: now + 1000 } } };
    assert.equal(T.heatLevelOf(data, "asgarnia", now), 2);
    assert.equal(T.heatLevelOf(data, "asgarnia", now + 1001), 0);
  });

  it("clamps to the maximum heat", () => {
    const now = 1_000_000;
    const data = { heat: { asgarnia: { level: 99, until: now + 1000 } } };
    assert.equal(T.heatLevelOf(data, "asgarnia", now), 3);
  });

  it("distance is euclidean", () => {
    assert.equal(T.dist2(0, 0, 3, 4), 5);
  });
});
