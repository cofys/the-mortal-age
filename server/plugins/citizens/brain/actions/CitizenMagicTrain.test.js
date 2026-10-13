"use strict";

/**
 * CitizenMagicTrain — verifies the citizen_magic_train activity is wired.
 *
 * Tests:
 * 1. The activity is defined in citizen-activities.json with a trainCombat
 *    action in magic style (stages from level 1, magic gear tiers with
 *    staves + real spell keys inlined, guard+commoner roles).
 * 2. The decision layer scores it above default for a keen low-level
 *    citizen, and low for a hurt one.
 * 3. Spell progression: strikes at tier 1, bolts at 13, blasts at 41 —
 *    the way players actually train Magic.
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
  const act = data.activities.find((a) => a.id === "citizen_magic_train");
  assert.ok(act, "citizen_magic_train activity must exist");
  return act;
}

describe("citizen_magic_train activity", () => {
  test("is defined with a magic trainCombat action", () => {
    const act = loadActivity();
    assert.equal(act.mode, "citizen_magic_train");
    assert.deepEqual(act.produces, ["magic", "hitpoints"]);
    const types = act.actions.map((a) => a.type);
    assert.deepEqual(types, ["trainCombat"]);
  });

  test("stages start at level 1 and magic tiers are inlined", () => {
    const act = loadActivity();
    const spec = act.actions[0];
    assert.deepEqual(spec.styles, ["magic"]);
    assert.ok(Array.isArray(spec.stages) && spec.stages.length > 0);
    const sorted = [...spec.stages].sort((a, b) => a.minLevel - b.minLevel);
    assert.equal(sorted[0].minLevel, 1, "stages must start at level 1");
    assert.ok(!("gearRef" in spec), "no unresolved gearRef allowed");
    assert.ok(!("rangedTiers" in spec), "magic activity carries no ranged tiers");
    const tiers = spec.magicTiers;
    assert.ok(Array.isArray(tiers) && tiers.length > 0, "magicTiers inlined");
    assert.equal(
      [...tiers].sort((a, b) => a.minLevel - b.minLevel)[0].minLevel,
      1,
      "magic tiers start at level 1"
    );
  });

  test("every magic tier has a staff and real spell keys", () => {
    const act = loadActivity();
    for (const tier of act.actions[0].magicTiers) {
      assert.ok(tier.weapons.length > 0, `tier ${tier.minLevel}: needs a staff`);
      assert.ok(tier.spells.length > 0, `tier ${tier.minLevel}: needs spells`);
      for (const s of tier.spells) {
        assert.equal(typeof s, "string", "spell keys are strings");
        assert.match(s, /^[A-Z_]+$/, `${s} must be a CombatSpells key`);
      }
      for (const w of tier.weapons) {
        assert.match(w, /STAFF/, `${w} must be a staff`);
      }
    }
  });

  test("spell progression follows the player curve", () => {
    const act = loadActivity();
    const byMin = new Map(
      act.actions[0].magicTiers.map((t) => [t.minLevel, t.spells])
    );
    assert.ok(byMin.get(1).includes("WIND_STRIKE"), "tier 1: wind strike");
    assert.ok(
      byMin.get(13).some((s) => s.endsWith("_BOLT")),
      "tier 13: bolts"
    );
    assert.ok(
      byMin.get(41).some((s) => s.endsWith("_BLAST")),
      "tier 41: blasts"
    );
  });

  test("requires guard or commoner role", () => {
    const act = loadActivity();
    const roles = act.requires?.[0]?.citizen?.roles;
    assert.ok(roles?.includes("guard"), "guards can train magic");
    assert.ok(roles?.includes("commoner"), "commoners can train magic");
  });
});

describe("citizen_magic_train decision scoring", () => {
  function snap(over = {}) {
    return {
      hp: 100, energy: 100, mood: 50,
      goal: null, personality: { traits: [] },
      role: "commoner", combatLevel: 3, rangedLevel: 1, magicLevel: 1,
      coins: 500, food: 5, freeSlots: 20, nearby: 0, hour: 10,
      ...over,
    };
  }

  test("keen low-level citizen with combat goal scores high", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const s = scoreActivity("citizen_magic_train", snap({
      personality: { traits: ["daydreamer", "methodical"] },
      role: "guard",
      goal: { type: "boss_slayer" },
      magicLevel: 1,
    }));
    // 28 + industrious(0.7)*10 + 14 daydreamer + 8 guard + 16 goal + 12 low = 85
    assert.ok(s > 70, `eager mage should score high, got ${s}`);
  });

  test("hurt citizen stays home", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const s = scoreActivity("citizen_magic_train", snap({
      hp: 20, // below CRITICAL_HP (30)
      personality: { traits: ["daydreamer"] },
      magicLevel: 1,
    }));
    assert.ok(s < 40, `hurt citizen should not train, got ${s}`);
  });

  test("veteran tapers off vs a level 1", () => {
    const { scoreActivity } = require("../CitizenDecisions");
    const rookie = scoreActivity("citizen_magic_train", snap({ magicLevel: 1 }));
    const veteran = scoreActivity("citizen_magic_train", snap({ magicLevel: 45 }));
    assert.ok(rookie > veteran,
      `level 1 (${rookie}) should want training more than level 45 (${veteran})`);
  });
});
