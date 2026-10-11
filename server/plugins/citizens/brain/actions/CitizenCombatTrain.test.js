"use strict";

/**
 * CitizenCombatTrain — verifies the citizen_combat_train activity is wired.
 *
 * Tests:
 * 1. The activity is defined in citizen-activities.json with a trainCombat
 *    action (stages from level 1, melee gear tiers, guard+commoner roles).
 * 2. The decision layer scores it above default for a brave low-level
 *    citizen, and low for a hurt one.
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
  const act = data.activities.find((a) => a.id === "citizen_combat_train");
  assert.ok(act, "citizen_combat_train activity must exist");
  return act;
}

describe("citizen_combat_train activity", () => {
  test("is defined with a trainCombat action", () => {
    const act = loadActivity();
    assert.equal(act.mode, "citizen_combat_train");
    assert.deepEqual(act.produces, ["attack", "strength", "defence", "hitpoints"]);
    const types = act.actions.map((a) => a.type);
    assert.deepEqual(types, ["trainCombat"]);
  });

  test("stages start at level 1 and gear tiers are inlined", () => {
    const act = loadActivity();
    const spec = act.actions[0];
    assert.ok(Array.isArray(spec.stages) && spec.stages.length > 0);
    const sorted = [...spec.stages].sort((a, b) => a.minLevel - b.minLevel);
    assert.equal(sorted[0].minLevel, 1, "stages must start at level 1");
    assert.ok(Array.isArray(spec.gearTiers) && spec.gearTiers.length > 0,
      "melee gear tiers must be inlined (gearRef is not expanded for appended activities)");
    assert.deepEqual(spec.styles, ["melee"]);
    assert.ok(!("gearRef" in spec), "no unresolved gearRef allowed");
  });

  test("requires guard or commoner role", () => {
    const act = loadActivity();
    const roles = act.requires?.[0]?.citizen?.roles;
    assert.ok(roles?.includes("guard"), "guards can train");
    assert.ok(roles?.includes("commoner"), "commoners can train");
  });
});

describe("citizen_combat_train decision scoring", () => {
  function snap(over = {}) {
    return {
      hp: 100, energy: 100, mood: 50,
      goal: null, personality: { traits: [] },
      role: "commoner", combatLevel: 3,
      coins: 500, food: 5, freeSlots: 20, nearby: 0, hour: 10,
      ...over,
    };
  }

  test("brave low-level guard with combat goal scores high", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const s = scoreActivity("citizen_combat_train", snap({
      personality: { traits: ["brave", "dutiful"] },
      role: "guard",
      goal: { type: "boss_slayer" },
      combatLevel: 3,
    }));
    // 30 + industrious(0.7)*10 + 14 brave + 12 guard + 16 goal + 12 low level = 91
    assert.ok(s > 70, `eager trainee should score high, got ${s}`);
  });

  test("hurt citizen stays home", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const s = scoreActivity("citizen_combat_train", snap({
      hp: 20, // below CRITICAL_HP (30)
      personality: { traits: ["brave"] },
      combatLevel: 3,
    }));
    assert.ok(s < 40, `hurt citizen should not train, got ${s}`);
  });

  test("veteran tapers off vs a level 3", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const rookie = scoreActivity("citizen_combat_train", snap({ combatLevel: 3 }));
    const veteran = scoreActivity("citizen_combat_train", snap({ combatLevel: 45 }));
    assert.ok(rookie > veteran,
      `level 3 (${rookie}) should want training more than level 45 (${veteran})`);
  });
});
