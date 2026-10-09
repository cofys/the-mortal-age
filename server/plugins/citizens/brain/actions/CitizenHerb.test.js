"use strict";

/**
 * CitizenHerb unit checks — clean herbs and mix potions for real Herblore XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenHerb".
 *   - No Herblore plugin -> "failed" (fail fast, don't stall).
 *   - Session already active -> "running".
 *   - No herbs in pack or bank -> "success" (done, brain re-decides).
 *   - Grimy herbs in pack -> startBotHerblore with the right count.
 *   - Clean herb but no vials -> "success" (can't mix without a partner).
 *   - Kind priority: unfinished potion + secondary beats cleaning grimy
 *     herbs at the same level.
 *   - Bank holds herbs -> walks to bank and withdraws (vials included).
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _bestInventoryRecipe: picks highest-tier doable recipe; level-gates.
 *   - _bestBankPlan: withdraws herb + partner (vial/secondary) together.
 *   - _herbMaterials: counts pack first, bank second, partner-aware.
 *   - Decision scoring: citizen_herb scores 4 with no herbs, high for an
 *     industrious broke trader with herbs, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenCraft.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _herbloreLevel falls back to 1 — the level-gate branches are exercised
 * through that fallback (guam eligible, marrentill gated).
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard OSRS) -----------------------------------------------
const GRIMY_GUAM = 199;
const GUAM = 249;
const GUAM_UNF = 91;
const VIAL_OF_WATER = 227;
const EYE_OF_NEWT = 221;
const ATTACK_3 = 121;
const GRIMY_MARRENTILL = 201;
const MARRENTILL = 251;
const MARRENTILL_UNF = 93;
const UNICORN_HORN_DUST = 235;

// --- stubs ------------------------------------------------------------------
const herbCalls = [];
const withdrawActions = [];

let mockHerblore = null;

const RECIPES = [
  { kind: "clean", name: "Clean herb", inputId: GRIMY_GUAM, needsId: null, outputId: GUAM, level: 1, xp: 2 },
  { kind: "unfinished", name: "Mix unfinished potion", inputId: GUAM, needsId: VIAL_OF_WATER, outputId: GUAM_UNF, level: 1, xp: 10 },
  { kind: "finished", name: "Mix potion", inputId: GUAM_UNF, needsId: EYE_OF_NEWT, outputId: ATTACK_3, level: 1, xp: 25 },
  { kind: "clean", name: "Clean herb", inputId: GRIMY_MARRENTILL, needsId: null, outputId: MARRENTILL, level: 5, xp: 4 },
  { kind: "unfinished", name: "Mix unfinished potion", inputId: MARRENTILL, needsId: VIAL_OF_WATER, outputId: MARRENTILL_UNF, level: 5, xp: 10 },
];

function defaultHerbloreMock() {
  return {
    HERBLORE_RECIPES: RECIPES,
    startBotHerblore: (player, amount) => {
      herbCalls.push({ player, amount });
      return true;
    },
    isHerbloreActive: () => false,
  };
}

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: () => true,
      clearMovementRequest: () => {},
      approachObject: () => true,
    },
    "../../../bots/brain/actions/Bank": {
      createBankAction: (spec, world) => {
        const delegate = {
          spec,
          updates: 0,
          update: () => {
            delegate.updates += 1;
            return "success";
          },
          stop: () => {},
        };
        withdrawActions.push(delegate);
        return delegate;
      },
    },
    "../CitizenSites": {
      siteTile: () => ({ x: 3000, y: 3000, z: 0 }),
      kingdomIdOf: () => "asgarnia",
    },
    "../../constants": require("../../constants"),
    "../../lib/humanizer": {
      agentRng: () => Math.random,
      personalSpot: (username, x, y) => ({ x: x + 2, y: y + 2 }),
      humanizerProfile: () => ({}),
    },
    "../../../skills/Herblore.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockHerblore && prop in mockHerblore) {
            return mockHerblore[prop];
          }
          return undefined;
        },
      }
    ),
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const full = path.join(__dirname, rel);
    const resolved = require.resolve(full);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }
}
stubEngineModules();

const {
  createCitizenHerbAction,
  _herbMaterialsFromInventory: herbMaterialsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _herbMaterials: herbMaterials,
} = require("./CitizenHerb");
const { scoreActivity } = require("../CitizenDecisions");

// --- mock players ------------------------------------------------------------

function mockInventory(amounts) {
  const map = new Map(Object.entries(amounts).map(([k, v]) => [Number(k), v]));
  return {
    getAmount: (id) => map.get(id) ?? 0,
    getItems: () =>
      [...map.entries()].map(([id]) => ({
        getId: () => id,
      })),
  };
}

function mockBankTab(amounts) {
  const entries = Object.entries(amounts).map(([k, v]) => [Number(k), v]);
  return {
    getSlotForItemId: (id) => entries.findIndex(([eid]) => eid === id),
    getItems: () => entries.map(([id, amt]) => ({ getId: () => id, getAmount: () => amt })),
  };
}

function mockPlayer({
  inv = {},
  bankTabs = [],
  playerAt = { x: 10, y: 10 },
} = {}) {
  const inventory = mockInventory(inv);
  const tabs = bankTabs.map(mockBankTab);
  return {
    getInventory: () => inventory,
    getBank: (tab) => tabs[tab] ?? null,
    getSkillManager: () => ({
      // Skill enum unavailable in plain node; the action falls back to 1.
      getCurrentLevel: () => {
        throw new Error("no enum in test");
      },
    }),
    getLocation: () => ({
      getX: () => playerAt.x,
      getY: () => playerAt.y,
      getZ: () => 0,
    }),
    getUsername: () => "Test Herbalist",
    getAttribute: () => ({}),
    getPrivateArea: () => null,
  };
}

function mockWorld() {
  return { log: () => {} };
}

function freshAction(world) {
  herbCalls.length = 0;
  withdrawActions.length = 0;
  mockHerblore = defaultHerbloreMock();
  return createCitizenHerbAction({}, world);
}

// --- tests -------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenHerb action", () => {
  const action = freshAction(mockWorld());
  assert.equal(action.id, "citizenHerb");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Herblore plugin -> failed", () => {
  mockHerblore = null;
  const player = mockPlayer();
  const action = createCitizenHerbAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "failed");
});

test("herblore already active -> running", () => {
  mockHerblore = defaultHerbloreMock();
  mockHerblore.isHerbloreActive = () => true;
  const player = mockPlayer({ inv: { [GRIMY_GUAM]: 5 } });
  const action = createCitizenHerbAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "running");
});

test("no herbs in pack or bank -> success", () => {
  const player = mockPlayer({ inv: {} });
  const action = freshAction(mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "success");
});

test("grimy herbs in pack -> starts bot herblore", () => {
  const player = mockPlayer({ inv: { [GRIMY_GUAM]: 12 } });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.equal(herbCalls.length, 1);
  assert.equal(herbCalls[0].amount, 12);
});

test("clean herb but no vials -> success (can't mix without a partner)", () => {
  const player = mockPlayer({ inv: { [GUAM]: 10 } });
  const action = freshAction(mockWorld());
  assert.equal(action.update({ player, nowMs: 100000 }), "success");
});

test("kind priority: finishing beats cleaning at the same level", () => {
  const player = mockPlayer({
    inv: { [GRIMY_GUAM]: 10, [GUAM_UNF]: 3, [EYE_OF_NEWT]: 3 },
  });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.equal(herbCalls.length, 1);
  // Limited by the partner: 3 unf + 3 eye of newt = 3 potions.
  assert.equal(herbCalls[0].amount, 3);
});

test("bank holds herbs -> walks to bank and withdraws with partners", () => {
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [GUAM]: 14, [VIAL_OF_WATER]: 14 }],
    playerAt: { x: 3002, y: 3002 }, // already at the bank anchor
  });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.ok(withdrawActions.length > 0, "should delegate a bank withdraw");
  const spec = withdrawActions[0].spec;
  assert.ok(
    spec.withdraw.some((w) => w.item === GUAM),
    "withdraw spec covers the herb"
  );
  assert.ok(
    spec.withdraw.some((w) => w.item === VIAL_OF_WATER),
    "withdraw spec fetches the partner vials"
  );
});

test("give-up timeout -> success, never stalls", () => {
  const player = mockPlayer({ inv: {} });
  const action = freshAction(mockWorld());
  // First tick arms the timer (no herbs -> success path), far-future tick
  // would give up even mid-withdraw.
  action.update({ player, nowMs: 1000 });
  assert.equal(action.update({ player, nowMs: 1000 + 7 * 60 * 1000 }), "success");
});

test("_bestInventoryRecipe picks highest tier, gates by level", () => {
  mockHerblore = defaultHerbloreMock();
  // Level falls back to 1 in plain node: guam chain eligible, marrentill gated.
  const p1 = mockPlayer({ inv: { [GRIMY_GUAM]: 4, [GUAM]: 6, [VIAL_OF_WATER]: 6 } });
  const pick = bestInventoryRecipe(mockHerblore, p1);
  assert.ok(pick, "should find a recipe");
  assert.equal(pick.kind, "unfinished");
  assert.equal(pick.inputId, GUAM);

  const p2 = mockPlayer({ inv: { [GRIMY_MARRENTILL]: 20 } });
  assert.equal(bestInventoryRecipe(mockHerblore, p2), null);

  const p3 = mockPlayer({ inv: { [GUAM]: 5 } });
  assert.equal(bestInventoryRecipe(mockHerblore, p3), null);
});

test("_herbMaterialsFromInventory is partner-aware", () => {
  mockHerblore = defaultHerbloreMock();
  const p1 = mockPlayer({ inv: { [GRIMY_GUAM]: 7 } });
  assert.equal(herbMaterialsFromInventory(mockHerblore, p1), 7); // cleaning needs nothing

  const p2 = mockPlayer({ inv: { [GUAM]: 9 } });
  assert.equal(herbMaterialsFromInventory(mockHerblore, p2), 0); // no vials, no work

  const p3 = mockPlayer({ inv: { [GUAM]: 9, [VIAL_OF_WATER]: 4 } });
  assert.equal(herbMaterialsFromInventory(mockHerblore, p3), 9);
});

test("_bestBankPlan withdraws herb + partner from the bank", () => {
  mockHerblore = defaultHerbloreMock();
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [GRIMY_GUAM]: 30 }],
  });
  const plan = bestBankPlan(mockHerblore, player);
  assert.ok(plan, "should plan a bank withdrawal");
  assert.equal(plan.recipe.kind, "clean");
  const grimy = plan.withdraw.find((w) => w.item === GRIMY_GUAM);
  assert.ok(grimy.amount >= 27);

  const p2 = mockPlayer({
    inv: {},
    bankTabs: [{ [GUAM]: 14, [VIAL_OF_WATER]: 14 }],
  });
  const plan2 = bestBankPlan(mockHerblore, p2);
  assert.ok(plan2, "should plan an unfinished-potion withdrawal");
  assert.equal(plan2.recipe.kind, "unfinished");
  assert.ok(plan2.withdraw.some((w) => w.item === GUAM));
  assert.ok(plan2.withdraw.some((w) => w.item === VIAL_OF_WATER));

  const p3 = mockPlayer({ inv: {}, bankTabs: [] });
  assert.equal(bestBankPlan(mockHerblore, p3), null);
});

test("_herbMaterials counts pack first, bank second", () => {
  mockHerblore = defaultHerbloreMock();
  const p1 = mockPlayer({
    inv: { [GRIMY_GUAM]: 5 },
    bankTabs: [{ [GRIMY_GUAM]: 100 }],
  });
  assert.equal(herbMaterials(mockHerblore, p1), 5);

  const p2 = mockPlayer({
    inv: {},
    bankTabs: [{ [GUAM_UNF]: 9, [EYE_OF_NEWT]: 9 }],
  });
  assert.equal(herbMaterials(mockHerblore, p2), 9);

  const p3 = mockPlayer({ inv: {} });
  assert.equal(herbMaterials(mockHerblore, p3), 0);
});

function baseSnap(over = {}) {
  return {
    hp: 100,
    energy: 100,
    mood: 80,
    goal: null,
    personality: { traits: [] },
    coins: 500,
    food: 5,
    freeSlots: 20,
    nearby: 0,
    logs: 0,
    ore: 0,
    gems: 0,
    rawFood: 0,
    herbs: 0,
    hour: 12,
    ...over,
  };
}

test("decision: no herbs -> score 4, never picked", () => {
  assert.equal(scoreActivity("citizen_herb", baseSnap({ herbs: 0 })), 4);
});

test("decision: industrious broke trader with herbs wants to mix", () => {
  const s = scoreActivity(
    "citizen_herb",
    baseSnap({
      herbs: 12,
      coins: 30,
      personality: { traits: ["dutiful", "greedy"] },
      goal: { type: "master_trade" },
    })
  );
  assert.ok(s > 50, `expected a strong herb score, got ${s}`);
});

test("decision: hurt citizen stays away from the herbs", () => {
  const s = scoreActivity("citizen_herb", baseSnap({ herbs: 12, hp: 20 }));
  const well = scoreActivity("citizen_herb", baseSnap({ herbs: 12 }));
  assert.ok(s < well, `hurt (${s}) should score below well (${well})`);
});
