"use strict";

/**
 * CitizenCook unit checks — cook raw food for real Cooking XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenCook".
 *   - No Cooking plugin -> "failed" (fail fast, don't stall).
 *   - Cooking already active -> "running".
 *   - No raw food in pack or bank -> "success" (done, brain re-decides).
 *   - Raw food in pack + cook spot nearby -> walks to the fire/range and
 *     calls startBotCooking with the object and recipe.
 *   - Raw food in pack but no fire/range nearby -> "success" (re-decide —
 *     the brain may pick firemaking).
 *   - Raw food in bank but not pack -> walks to bank and withdraws.
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _bestInventoryRecipe: picks the highest-level recipe the (level-1
 *     fallback) citizen qualifies for; skips level-gated recipes.
 *   - _bestBankPlan: builds a withdraw plan from bank raw food.
 *   - _cookableFood: counts inventory food first, bank food second.
 *   - _findCookSpot: prefers ranges over fires, skips fires for
 *     rangeOnly recipes.
 *   - Decision scoring: citizen_cook scores 4 with no raw food, high for an
 *     industrious broke trader with food, bonus when low on food,
 *     penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenCraft.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _cookingLevel falls back to 1 — the level-gate branches are exercised
 * through that fallback (shrimp eligible, trout gated).
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard OSRS) -----------------------------------------------
const RAW_SHRIMPS = 317;
const RAW_SARDINE = 327;
const RAW_TROUT = 335;
const RAW_SALMON = 331;

// --- object ids --------------------------------------------------------------
const FIRE_ID = 5249;
const RANGE_ID = 114;

// --- stubs ------------------------------------------------------------------
const cookCalls = [];
const withdrawActions = [];

let mockCooking = null;

const RECIPES = [
  { name: "Cook shrimp", rawId: RAW_SHRIMPS, cookedId: 315, burntId: 7954, level: 1, xp: 30, stopBurn: 33 },
  { name: "Cook sardine", rawId: RAW_SARDINE, cookedId: 325, burntId: 7954, level: 1, xp: 40, stopBurn: 38 },
  { name: "Cook trout", rawId: RAW_TROUT, cookedId: 333, burntId: 7954, level: 15, xp: 70, stopBurn: 50 },
  { name: "Cook salmon", rawId: RAW_SALMON, cookedId: 329, burntId: 7954, level: 25, xp: 90, stopBurn: 58 },
];

function defaultCookingMock() {
  return {
    COOKING_RECIPES: RECIPES,
    COOK_OBJECT_IDS: [FIRE_ID, RANGE_ID],
    startBotCooking: (player, object, cookable) => {
      cookCalls.push({ player, object, cookable });
      return true;
    },
    isCookingActive: () => false,
  };
}

function mockCookObject(id, x, y, name) {
  return {
    getId: () => id,
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => 0,
    }),
    getDefinition: () => ({
      getName: () => name,
    }),
  };
}

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: () => true,
      clearMovementRequest: () => {},
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
    "../../../bots/brain/BotObjectCatalog": {
      resolveCatalogObjectIds: () => [],
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
    "../../../skills/Cooking.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockCooking && prop in mockCooking) {
            return mockCooking[prop];
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
  createCitizenCookAction,
  _rawFoodFromInventory: rawFoodFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _cookableFood: cookableFood,
  _findCookSpot: findCookSpot,
} = require("./CitizenCook");
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
    getMovementQueue: () => ({
      size: () => 0,
      walkToObject: (obj, opts) => {
        // Immediately "arrive" — run the interaction callback.
        opts.execute();
        return true;
      },
    }),
    getForceMovement: () => null,
    getUsername: () => "Test Cook",
    getAttribute: () => ({}),
    getPrivateArea: () => null,
  };
}

function mockWorld({ cookObjects = [] } = {}) {
  return {
    log: () => {},
    objectSearch: {
      findCandidatesByIds: () => cookObjects,
    },
    emitObjectInteraction: () => {},
  };
}

function freshAction(world) {
  cookCalls.length = 0;
  withdrawActions.length = 0;
  mockCooking = defaultCookingMock();
  return createCitizenCookAction({}, world);
}

// --- tests -------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenCook action", () => {
  const action = freshAction(mockWorld());
  assert.equal(action.id, "citizenCook");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Cooking plugin -> failed", () => {
  mockCooking = null;
  const player = mockPlayer();
  const action = createCitizenCookAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "failed");
});

test("cooking already active -> running", () => {
  mockCooking = defaultCookingMock();
  mockCooking.isCookingActive = () => true;
  const player = mockPlayer({ inv: { [RAW_SHRIMPS]: 5 } });
  const action = createCitizenCookAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "running");
});

test("no raw food in pack or bank -> success", () => {
  const player = mockPlayer({ inv: {} });
  const action = freshAction(mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "success");
});

test("raw food in pack + fire nearby -> starts bot cooking", () => {
  const fire = mockCookObject(FIRE_ID, 12, 12, "Fire");
  const player = mockPlayer({ inv: { [RAW_SHRIMPS]: 12 } });
  const action = freshAction(mockWorld({ cookObjects: [fire] }));
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.equal(cookCalls.length, 1);
  assert.equal(cookCalls[0].cookable.rawId, RAW_SHRIMPS);
  assert.equal(cookCalls[0].object, fire);
});

test("raw food in pack but no fire/range nearby -> success (re-decide)", () => {
  const player = mockPlayer({ inv: { [RAW_SHRIMPS]: 12 } });
  const action = freshAction(mockWorld({ cookObjects: [] }));
  assert.equal(action.update({ player, nowMs: 100000 }), "success");
});

test("raw food in bank but not pack -> walks to bank and withdraws", () => {
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [RAW_SHRIMPS]: 20 }],
    playerAt: { x: 3002, y: 3002 }, // already at the bank anchor
  });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.ok(withdrawActions.length > 0, "should delegate a bank withdraw");
  const spec = withdrawActions[0].spec;
  assert.ok(
    spec.withdraw.some((w) => w.item === RAW_SHRIMPS),
    "withdraw spec covers raw shrimps"
  );
});

test("give-up timeout -> success, never stalls", () => {
  const player = mockPlayer({ inv: {} });
  const action = freshAction(mockWorld());
  action.update({ player, nowMs: 1000 });
  assert.equal(action.update({ player, nowMs: 1000 + 7 * 60 * 1000 }), "success");
});

test("_bestInventoryRecipe picks shrimp, gates trout by level", () => {
  mockCooking = defaultCookingMock();
  // Level falls back to 1 in plain node: shrimp eligible, trout gated.
  const p1 = mockPlayer({ inv: { [RAW_SHRIMPS]: 4, [RAW_TROUT]: 20 } });
  const pick = bestInventoryRecipe(mockCooking, p1);
  assert.ok(pick, "should find a recipe");
  assert.equal(pick.rawId, RAW_SHRIMPS);

  const p2 = mockPlayer({ inv: { [RAW_TROUT]: 20 } });
  assert.equal(bestInventoryRecipe(mockCooking, p2), null);

  const p3 = mockPlayer({ inv: {} });
  assert.equal(bestInventoryRecipe(mockCooking, p3), null);
});

test("_rawFoodFromInventory counts level-gated food", () => {
  mockCooking = defaultCookingMock();
  const p1 = mockPlayer({ inv: { [RAW_SHRIMPS]: 7, [RAW_TROUT]: 30 } });
  assert.equal(rawFoodFromInventory(mockCooking, p1), 7); // trout gated at level 1

  const p2 = mockPlayer({ inv: {} });
  assert.equal(rawFoodFromInventory(mockCooking, p2), 0);
});

test("_bestBankPlan withdraws bank food when the pack is empty", () => {
  mockCooking = defaultCookingMock();
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [RAW_SHRIMPS]: 30 }],
  });
  const plan = bestBankPlan(mockCooking, player);
  assert.ok(plan, "should plan a bank withdrawal");
  assert.equal(plan.recipe.rawId, RAW_SHRIMPS);
  const shrimp = plan.withdraw.find((w) => w.item === RAW_SHRIMPS);
  assert.ok(shrimp.amount >= 27);

  const p2 = mockPlayer({ inv: {}, bankTabs: [] });
  assert.equal(bestBankPlan(mockCooking, p2), null);
});

test("_cookableFood counts inventory first, bank second", () => {
  mockCooking = defaultCookingMock();
  const p1 = mockPlayer({
    inv: { [RAW_SHRIMPS]: 5 },
    bankTabs: [{ [RAW_SHRIMPS]: 100 }],
  });
  assert.equal(cookableFood(mockCooking, p1), 5);

  const p2 = mockPlayer({
    inv: {},
    bankTabs: [{ [RAW_SHRIMPS]: 9 }],
  });
  assert.equal(cookableFood(mockCooking, p2), 9);

  const p3 = mockPlayer({ inv: {} });
  assert.equal(cookableFood(mockCooking, p3), 0);
});

test("_findCookSpot prefers ranges over nearer fires", () => {
  mockCooking = defaultCookingMock();
  const world = mockWorld();
  const player = mockPlayer({ playerAt: { x: 10, y: 10 } });
  const nearFire = mockCookObject(FIRE_ID, 11, 11, "Fire");
  const closeRange = mockCookObject(RANGE_ID, 13, 13, "Range");
  // Override the world's search to return both.
  world.objectSearch.findCandidatesByIds = () => [nearFire, closeRange];
  const spot = findCookSpot(world, player, mockCooking, null);
  assert.equal(spot, closeRange, "range should win over a comparably-close fire");
});

test("_findCookSpot skips fires for rangeOnly recipes", () => {
  mockCooking = defaultCookingMock();
  const world = mockWorld();
  const player = mockPlayer({ playerAt: { x: 10, y: 10 } });
  const fire = mockCookObject(FIRE_ID, 11, 11, "Fire");
  world.objectSearch.findCandidatesByIds = () => [fire];
  const rangeOnlyRecipe = { rawId: 999, rangeOnly: true };
  const spot = findCookSpot(world, player, mockCooking, rangeOnlyRecipe);
  assert.equal(spot, null, "bread dough needs a range, not a fire");
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
    hour: 12,
    ...over,
  };
}

test("decision: no raw food -> score 4, never picked", () => {
  assert.equal(scoreActivity("citizen_cook", baseSnap({ rawFood: 0 })), 4);
});

test("decision: industrious broke trader with food wants the fire", () => {
  const s = scoreActivity(
    "citizen_cook",
    baseSnap({
      rawFood: 12,
      coins: 30,
      personality: { traits: ["dutiful", "greedy"] },
      goal: { type: "master_trade" },
    })
  );
  assert.ok(s > 50, `expected a strong cook score, got ${s}`);
});

test("decision: low on food -> bonus to cook", () => {
  const low = scoreActivity("citizen_cook", baseSnap({ rawFood: 12, food: 1 }));
  const stocked = scoreActivity("citizen_cook", baseSnap({ rawFood: 12, food: 10 }));
  assert.ok(low > stocked, `low food (${low}) should outscore stocked (${stocked})`);
});

test("decision: hurt citizen stays away from the fire", () => {
  const s = scoreActivity("citizen_cook", baseSnap({ rawFood: 12, hp: 20 }));
  const well = scoreActivity("citizen_cook", baseSnap({ rawFood: 12 }));
  assert.ok(s < well, `hurt (${s}) should score below well (${well})`);
});
