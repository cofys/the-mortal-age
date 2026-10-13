"use strict";

/**
 * CitizenRangedTrain — verifies the citizen_ranged_train activity is wired.
 *
 * Tests:
 * 1. The activity is defined in citizen-activities.json with a trainCombat
 *    action in ranged style (stages from level 1, ranged gear tiers with
 *    bows + arrows inlined, guard+commoner roles).
 * 2. The decision layer scores it above default for a brave low-level
 *    citizen, and low for a hurt one.
 * 3. Ranged gear tiers gate on real level requirements: tier 1 bows are
 *    usable at level 1, yew/magic shortbows need higher levels.
 */

const path = require("path");
const fs = require("fs");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const ACTIVITIES_PATH = path.join(
  __dirname, "..", "..", "data", "citizen-activities.json"
);

function loadActivity() {
  const data = JSON.parse(fs.readFileSync(ACTIVITIES_PATH, "utf8"));
  const act = data.activities.find((a) => a.id === "citizen_ranged_train");
  assert.ok(act, "citizen_ranged_train activity must exist");
  return act;
}

describe("citizen_ranged_train activity", () => {
  test("is defined with a ranged trainCombat action", () => {
    const act = loadActivity();
    assert.equal(act.mode, "citizen_ranged_train");
    assert.deepEqual(act.produces, ["ranged", "hitpoints"]);
    const types = act.actions.map((a) => a.type);
    assert.deepEqual(types, ["trainCombat"]);
  });

  test("stages start at level 1 and ranged tiers are inlined", () => {
    const act = loadActivity();
    const spec = act.actions[0];
    assert.deepEqual(spec.styles, ["ranged"]);
    assert.ok(Array.isArray(spec.stages) && spec.stages.length > 0);
    const sorted = [...spec.stages].sort((a, b) => a.minLevel - b.minLevel);
    assert.equal(sorted[0].minLevel, 1, "stages must start at level 1");
    assert.ok(!("gearRef" in spec), "no unresolved gearRef allowed");
    assert.ok(!("magicTiers" in spec), "ranged activity carries no magic tiers");
    const tiers = spec.rangedTiers;
    assert.ok(Array.isArray(tiers) && tiers.length > 0, "rangedTiers inlined");
    assert.equal(
      [...tiers].sort((a, b) => a.minLevel - b.minLevel)[0].minLevel,
      1,
      "ranged tiers start at level 1"
    );
  });

  test("every ranged tier has a bow, arrows, and armour", () => {
    const act = loadActivity();
    for (const tier of act.actions[0].rangedTiers) {
      assert.ok(tier.weapons.length > 0, `tier ${tier.minLevel}: needs a bow`);
      assert.ok(tier.ammo.length > 0, `tier ${tier.minLevel}: needs arrows`);
      assert.ok(
        Object.keys(tier.armour ?? {}).length > 0,
        `tier ${tier.minLevel}: needs armour`
      );
      for (const w of tier.weapons) {
        assert.match(w, /SHORTBOW|LONGBOW/, `${w} must be a bow`);
      }
      for (const a of tier.ammo) {
        assert.match(a, /_ARROW$/, `${a} must be arrows`);
      }
    }
  });

  test("low-level targets: beginner stage covers chickens", () => {
    const act = loadActivity();
    const beginner = act.actions[0].stages.find((s) => s.minLevel === 1);
    assert.ok(beginner, "level-1 stage exists");
    assert.ok(
      beginner.npcLevels.min <= 3 && beginner.npcLevels.max >= 1,
      "chickens (level 1-3) are valid beginner targets"
    );
  });

  test("requires guard or commoner role", () => {
    const act = loadActivity();
    const roles = act.requires?.[0]?.citizen?.roles;
    assert.ok(roles?.includes("guard"), "guards can train ranged");
    assert.ok(roles?.includes("commoner"), "commoners can train ranged");
  });
});

describe("citizen_ranged_train decision scoring", () => {
  function snap(over = {}) {
    return {
      hp: 100, energy: 100, mood: 50,
      goal: null, personality: { traits: [] },
      role: "commoner", combatLevel: 3, rangedLevel: 1, magicLevel: 1,
      coins: 500, food: 5, freeSlots: 20, nearby: 0, hour: 10,
      ...over,
    };
  }

  test("brave low-level guard with combat goal scores high", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const s = scoreActivity("citizen_ranged_train", snap({
      personality: { traits: ["brave", "dutiful"] },
      role: "guard",
      goal: { type: "boss_slayer" },
      rangedLevel: 1,
    }));
    // 30 + industrious(0.7)*10 + 14 brave + 12 guard + 16 goal + 12 low level = 91
    assert.ok(s > 70, `eager archer should score high, got ${s}`);
  });

  test("hurt citizen stays home", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const s = scoreActivity("citizen_ranged_train", snap({
      hp: 20, // below CRITICAL_HP (30)
      personality: { traits: ["brave"] },
      rangedLevel: 1,
    }));
    assert.ok(s < 40, `hurt citizen should not train, got ${s}`);
  });

  test("veteran tapers off vs a level 1", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const rookie = scoreActivity("citizen_ranged_train", snap({ rangedLevel: 1 }));
    const veteran = scoreActivity("citizen_ranged_train", snap({ rangedLevel: 45 }));
    assert.ok(rookie > veteran,
      `level 1 (${rookie}) should want training more than level 45 (${veteran})`);
  });
});
