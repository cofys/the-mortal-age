"use strict";

/**
 * CitizenSmelt unit checks — smelt ore into bars for real Smithing XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenSmelt".
 *   - No Smithing plugin -> "failed" (fail fast, don't stall).
 *   - Smelting already active -> "running".
 *   - No ore in pack or bank -> "success" (done, brain re-decides).
 *   - Ore in pack + furnace in range -> walkToObject fires, execute() calls
 *     startBotSmelting with the right recipe and bar count.
 *   - No furnace nearby -> "failed" (cooldown, don't spin).
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _bestInventoryRecipe: picks the highest-level recipe the (level-1
 *     fallback) citizen qualifies for; skips level-gated recipes.
 *   - _bestBankPlan: builds a withdraw plan from bank ore.
 *   - _smeltableBars: counts inventory bars first, bank bars second.
 *   - Decision scoring: citizen_smelt scores 4 with no ore, high for an
 *     industrious broke trader with ore, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenLightFire.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _smithingLevel falls back to 1 — the level-gate branches are exercised
 * through that fallback (bronze eligible, iron gated).
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard) -----------------------------------------------------
const COPPER_ORE = 436;
const TIN_ORE = 438;
const IRON_ORE = 440;
const COAL = 453;

// --- stubs ------------------------------------------------------------------
const movementCalls = [];
const smeltCalls = [];
const withdrawActions = [];

let mockSmithing = null;
let MockBankAction = null;

const RECIPES = [
  {
    name: "Bronze bar",
    barId: 2349,
    level: 1,
    xp: 6.2,
    ingredients: [
      [COPPER_ORE, 1],
      [TIN_ORE, 1],
    ],
  },
  {
    name: "Iron bar",
    barId: 2351,
    level: 15,
    xp: 12.5,
    ingredients: [[IRON_ORE, 1]],
  },
];

function defaultSmithingMock() {
  return {
    SMELTING_RECIPES: RECIPES,
    FURNACE_OBJECT_IDS: [615],
    startBotSmelting: (player, recipe, amount) => {
      smeltCalls.push({ player, recipe, amount });
      return true;
    },
    isSmeltingActive: () => false,
  };
}

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y, opts) => {
        movementCalls.push({ player, x, y, opts });
        return true;
      },
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
    "../../../bots/brain/BotObjectCatalog": {
      resolveCatalogObjectIds: () => [615],
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
    "../../../skills/Smithing.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockSmithing && prop in mockSmithing) {
            return mockSmithing[prop];
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
  createCitizenSmeltAction,
  _barsFromInventory: barsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _smeltableBars: smeltableBars,
} = require("./CitizenSmelt");
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
  furnaceAt = { x: 12, y: 12 },
  playerAt = { x: 10, y: 10 },
  smelting = false,
  moving = false,
} = {}) {
  const inventory = mockInventory(inv);
  const tabs = bankTabs.map(mockBankTab);
  let walkSpec = null;
  const queue = {
    size: () => (moving ? 1 : 0),
    walkToObject: (obj, spec) => {
      walkSpec = { obj, spec };
    },
  };
  const player = {
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
    getMovementQueue: () => queue,
    getForceMovement: () => null,
    getUsername: () => "Test Smith",
    getAttribute: () => ({}),
    getPrivateArea: () => null,
    _walkSpec: () => walkSpec,
  };
  const furnace = {
    getId: () => 615,
    getLocation: () => ({
      getX: () => furnaceAt.x,
      getY: () => furnaceAt.y,
      getZ: () => 0,
    }),
  };
  return { player, furnace, queue };
}

function mockWorld({ furnaces = "near" } = {}) {
  return {
    objectSearch: {
      findCandidatesByIds: (player, ids, opts) => {
        if (furnaces === "none") return [];
        return [player._furnace].filter(Boolean);
      },
    },
    emitObjectInteraction: () => {},
    log: () => {},
  };
}

function attachFurnace(ctx) {
  ctx.player._furnace = ctx.furnace;
  return ctx;
}

function freshAction(world) {
  movementCalls.length = 0;
  smeltCalls.length = 0;
  withdrawActions.length = 0;
  mockSmithing = defaultSmithingMock();
  return createCitizenSmeltAction({}, world);
}

// --- tests -------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenSmelt action", () => {
  const world = mockWorld();
  const action = freshAction(world);
  assert.equal(action.id, "citizenSmelt");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Smithing plugin -> failed", () => {
  mockSmithing = null;
  const { player } = mockPlayer();
  const action = createCitizenSmeltAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "failed");
});

test("smelting already active -> running", () => {
  mockSmithing = defaultSmithingMock();
  mockSmithing.isSmeltingActive = () => true;
  const { player } = mockPlayer({ inv: { [COPPER_ORE]: 5, [TIN_ORE]: 5 } });
  const action = createCitizenSmeltAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "running");
});

test("no ore in pack or bank -> success", () => {
  const { player } = mockPlayer({ inv: {} });
  const action = freshAction(mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "success");
});

test("ore in pack + furnace in range -> walks and smelts", () => {
  const ctx = attachFurnace(
    mockPlayer({ inv: { [COPPER_ORE]: 10, [TIN_ORE]: 10 } })
  );
  const world = mockWorld();
  const action = freshAction(world);
  const result = action.update({ player: ctx.player, nowMs: 100000 });
  assert.equal(result, "running");
  const walk = ctx.player._walkSpec();
  assert.ok(walk, "should walk to the furnace");
  // Fire the arrival callback like the movement queue would.
  walk.spec.execute();
  assert.equal(smeltCalls.length, 1);
  assert.equal(smeltCalls[0].recipe.name, "Bronze bar");
  assert.equal(smeltCalls[0].amount, 10);
});

test("no furnace nearby -> failed", () => {
  const { player } = mockPlayer({ inv: { [COPPER_ORE]: 10, [TIN_ORE]: 10 } });
  const action = freshAction(mockWorld({ furnaces: "none" }));
  assert.equal(action.update({ player, nowMs: 100000 }), "failed");
});

test("give-up timeout -> success, never stalls", () => {
  const { player } = mockPlayer({ inv: { [COPPER_ORE]: 10, [TIN_ORE]: 10 } });
  const action = freshAction(mockWorld({ furnaces: "none" }));
  // First tick arms the timer (fails: no furnace), far-future tick gives up.
  action.update({ player, nowMs: 1000 });
  assert.equal(action.update({ player, nowMs: 1000 + 7 * 60 * 1000 }), "success");
});

test("_bestInventoryRecipe picks bronze, gates iron by level", () => {
  mockSmithing = defaultSmithingMock();
  // Level falls back to 1 in plain node: bronze eligible, iron gated.
  const { player: p1 } = mockPlayer({
    inv: { [COPPER_ORE]: 4, [TIN_ORE]: 4, [IRON_ORE]: 20 },
  });
  const pick = bestInventoryRecipe(mockSmithing, p1);
  assert.ok(pick, "should find a recipe");
  assert.equal(pick.recipe.name, "Bronze bar");
  assert.equal(pick.bars, 4);

  const { player: p2 } = mockPlayer({ inv: { [IRON_ORE]: 20 } });
  assert.equal(bestInventoryRecipe(mockSmithing, p2), null);

  const { player: p3 } = mockPlayer({ inv: {} });
  assert.equal(bestInventoryRecipe(mockSmithing, p3), null);
});

test("_barsFromInventory counts the limiting ingredient", () => {
  const { player } = mockPlayer({ inv: { [COPPER_ORE]: 7, [TIN_ORE]: 3 } });
  assert.equal(barsFromInventory(player, RECIPES[0]), 3);
});

test("_bestBankPlan withdraws bank ore when the pack is empty", () => {
  mockSmithing = defaultSmithingMock();
  const { player } = mockPlayer({
    inv: {},
    bankTabs: [{ [COPPER_ORE]: 30, [TIN_ORE]: 30 }],
  });
  const plan = bestBankPlan(mockSmithing, player);
  assert.ok(plan, "should plan a bank withdrawal");
  assert.equal(plan.recipe.name, "Bronze bar");
  const copper = plan.withdraw.find((w) => w.item === COPPER_ORE);
  const tin = plan.withdraw.find((w) => w.item === TIN_ORE);
  assert.ok(copper.amount >= 14 && tin.amount >= 14);

  const { player: p2 } = mockPlayer({ inv: {}, bankTabs: [] });
  assert.equal(bestBankPlan(mockSmithing, p2), null);
});

test("_smeltableBars counts inventory first, bank second", () => {
  mockSmithing = defaultSmithingMock();
  const { player: p1 } = mockPlayer({
    inv: { [COPPER_ORE]: 5, [TIN_ORE]: 5 },
    bankTabs: [{ [COPPER_ORE]: 100, [TIN_ORE]: 100 }],
  });
  assert.equal(smeltableBars(mockSmithing, p1), 5);

  const { player: p2 } = mockPlayer({
    inv: {},
    bankTabs: [{ [COPPER_ORE]: 9, [TIN_ORE]: 9 }],
  });
  assert.equal(smeltableBars(mockSmithing, p2), 9);

  const { player: p3 } = mockPlayer({ inv: {} });
  assert.equal(smeltableBars(mockSmithing, p3), 0);
});

test("empty inventory + bank ore -> walks to bank and withdraws", () => {
  const { player } = mockPlayer({
    inv: {},
    bankTabs: [{ [COPPER_ORE]: 30, [TIN_ORE]: 30 }],
    playerAt: { x: 3002, y: 3002 }, // already at the bank anchor
  });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.ok(
    withdrawActions.length > 0,
    "should delegate a bank withdraw for the ore"
  );
  const spec = withdrawActions[0].spec;
  assert.ok(
    spec.withdraw.some((w) => w.item === COPPER_ORE),
    "withdraw spec covers copper ore"
  );
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
    hour: 12,
    ...over,
  };
}

test("decision: no ore -> score 4, never picked", () => {
  assert.equal(scoreActivity("citizen_smelt", baseSnap({ ore: 0 })), 4);
});

test("decision: industrious broke trader with ore wants the furnace", () => {
  const s = scoreActivity(
    "citizen_smelt",
    baseSnap({
      ore: 12,
      coins: 30,
      personality: { traits: ["dutiful", "greedy"] },
      goal: { type: "master_trade" },
    })
  );
  assert.ok(s > 50, `expected a strong smelt score, got ${s}`);
});

test("decision: hurt citizen stays away from the furnace", () => {
  const s = scoreActivity("citizen_smelt", baseSnap({ ore: 12, hp: 20 }));
  const well = scoreActivity("citizen_smelt", baseSnap({ ore: 12 }));
  assert.ok(s < well, `hurt (${s}) should score below well (${well})`);
});
