"use strict";

/**
 * CitizenCraft unit checks — cut uncut gems for real Crafting XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenCraft".
 *   - No Crafting plugin -> "failed" (fail fast, don't stall).
 *   - Cutting already active -> "running".
 *   - No gems in pack or bank -> "success" (done, brain re-decides).
 *   - Gems + chisel in pack -> startBotCrafting with the right gem count.
 *   - No chisel in pack or bank -> "success" (can't cut).
 *   - Chisel in bank but not pack -> walks to bank and withdraws.
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _bestInventoryRecipe: picks the highest-level recipe the (level-1
 *     fallback) citizen qualifies for; skips level-gated recipes.
 *   - _bestBankPlan: builds a withdraw plan from bank gems (+ chisel when
 *     the citizen doesn't carry one).
 *   - _craftableGems: counts inventory gems first, bank gems second.
 *   - Decision scoring: citizen_craft scores 4 with no gems, high for an
 *     industrious broke trader with gems, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenSmelt.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _craftingLevel falls back to 1 — the level-gate branches are exercised
 * through that fallback (opal eligible, jade gated).
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard OSRS) -----------------------------------------------
const CHISEL = 1755;
const UNCUT_OPAL = 1625;
const UNCUT_JADE = 1627;
const UNCUT_SAPPHIRE = 1623;

// --- stubs ------------------------------------------------------------------
const craftCalls = [];
const withdrawActions = [];

let mockCrafting = null;

const RECIPES = [
  { name: "Cut gem", uncutId: UNCUT_OPAL, cutId: 1609, level: 1, xp: 15, animation: 890 },
  { name: "Cut gem", uncutId: UNCUT_JADE, cutId: 1611, level: 13, xp: 20, animation: 891 },
  { name: "Cut gem", uncutId: UNCUT_SAPPHIRE, cutId: 1607, level: 20, xp: 50, animation: 888 },
];

function defaultCraftingMock() {
  return {
    CRAFTING_RECIPES: RECIPES,
    startBotCrafting: (player, amount) => {
      craftCalls.push({ player, amount });
      return true;
    },
    isCraftingActive: () => false,
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
    "../../../skills/Crafting.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockCrafting && prop in mockCrafting) {
            return mockCrafting[prop];
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
  createCitizenCraftAction,
  _gemsFromInventory: gemsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _craftableGems: craftableGems,
  _hasChisel: hasChisel,
} = require("./CitizenCraft");
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
  crafting = false,
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
    getUsername: () => "Test Crafter",
    getAttribute: () => ({}),
    getPrivateArea: () => null,
  };
}

function mockWorld() {
  return { log: () => {} };
}

function freshAction(world) {
  craftCalls.length = 0;
  withdrawActions.length = 0;
  mockCrafting = defaultCraftingMock();
  return createCitizenCraftAction({}, world);
}

// --- tests -------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenCraft action", () => {
  const action = freshAction(mockWorld());
  assert.equal(action.id, "citizenCraft");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Crafting plugin -> failed", () => {
  mockCrafting = null;
  const player = mockPlayer();
  const action = createCitizenCraftAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "failed");
});

test("crafting already active -> running", () => {
  mockCrafting = defaultCraftingMock();
  mockCrafting.isCraftingActive = () => true;
  const player = mockPlayer({ inv: { [UNCUT_OPAL]: 5, [CHISEL]: 1 } });
  const action = createCitizenCraftAction({}, mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "running");
});

test("no gems in pack or bank -> success", () => {
  const player = mockPlayer({ inv: { [CHISEL]: 1 } });
  const action = freshAction(mockWorld());
  assert.equal(action.update({ player, nowMs: 1000 }), "success");
});

test("gems + chisel in pack -> starts bot crafting", () => {
  const player = mockPlayer({ inv: { [UNCUT_OPAL]: 12, [CHISEL]: 1 } });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.equal(craftCalls.length, 1);
  assert.equal(craftCalls[0].amount, 12);
});

test("no chisel in pack or bank -> success", () => {
  const player = mockPlayer({ inv: { [UNCUT_OPAL]: 12 } });
  const action = freshAction(mockWorld());
  assert.equal(action.update({ player, nowMs: 100000 }), "success");
});

test("chisel in bank but not pack -> walks to bank and withdraws", () => {
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [UNCUT_OPAL]: 20, [CHISEL]: 1 }],
    playerAt: { x: 3002, y: 3002 }, // already at the bank anchor
  });
  const action = freshAction(mockWorld());
  const result = action.update({ player, nowMs: 100000 });
  assert.equal(result, "running");
  assert.ok(withdrawActions.length > 0, "should delegate a bank withdraw");
  const spec = withdrawActions[0].spec;
  assert.ok(
    spec.withdraw.some((w) => w.item === UNCUT_OPAL),
    "withdraw spec covers uncut opal"
  );
  assert.ok(
    spec.withdraw.some((w) => w.item === CHISEL),
    "withdraw spec fetches the missing chisel"
  );
});

test("give-up timeout -> success, never stalls", () => {
  const player = mockPlayer({ inv: { [CHISEL]: 1 } });
  const action = freshAction(mockWorld());
  // First tick arms the timer (no gems -> success path), far-future tick
  // would give up even mid-withdraw.
  action.update({ player, nowMs: 1000 });
  assert.equal(action.update({ player, nowMs: 1000 + 7 * 60 * 1000 }), "success");
});

test("_bestInventoryRecipe picks opal, gates jade by level", () => {
  mockCrafting = defaultCraftingMock();
  // Level falls back to 1 in plain node: opal eligible, jade gated.
  const p1 = mockPlayer({ inv: { [UNCUT_OPAL]: 4, [UNCUT_JADE]: 20, [CHISEL]: 1 } });
  const pick = bestInventoryRecipe(mockCrafting, p1);
  assert.ok(pick, "should find a recipe");
  assert.equal(pick.uncutId, UNCUT_OPAL);

  const p2 = mockPlayer({ inv: { [UNCUT_JADE]: 20, [CHISEL]: 1 } });
  assert.equal(bestInventoryRecipe(mockCrafting, p2), null);

  const p3 = mockPlayer({ inv: { [CHISEL]: 1 } });
  assert.equal(bestInventoryRecipe(mockCrafting, p3), null);
});

test("_gemsFromInventory counts level-gated gems", () => {
  mockCrafting = defaultCraftingMock();
  const p1 = mockPlayer({ inv: { [UNCUT_OPAL]: 7, [UNCUT_JADE]: 30, [CHISEL]: 1 } });
  assert.equal(gemsFromInventory(mockCrafting, p1), 7); // jade gated at level 1

  const p2 = mockPlayer({ inv: { [CHISEL]: 1 } });
  assert.equal(gemsFromInventory(mockCrafting, p2), 0);
});

test("_bestBankPlan withdraws bank gems when the pack is empty", () => {
  mockCrafting = defaultCraftingMock();
  const player = mockPlayer({
    inv: { [CHISEL]: 1 },
    bankTabs: [{ [UNCUT_OPAL]: 30 }],
  });
  const plan = bestBankPlan(mockCrafting, player);
  assert.ok(plan, "should plan a bank withdrawal");
  assert.equal(plan.recipe.uncutId, UNCUT_OPAL);
  const opal = plan.withdraw.find((w) => w.item === UNCUT_OPAL);
  assert.ok(opal.amount >= 27);

  const p2 = mockPlayer({ inv: { [CHISEL]: 1 }, bankTabs: [] });
  assert.equal(bestBankPlan(mockCrafting, p2), null);
});

test("_hasChisel reads the pack", () => {
  assert.equal(hasChisel(mockPlayer({ inv: { [CHISEL]: 1 } })), true);
  assert.equal(hasChisel(mockPlayer({ inv: {} })), false);
});

test("_craftableGems counts inventory first, bank second", () => {
  mockCrafting = defaultCraftingMock();
  const p1 = mockPlayer({
    inv: { [UNCUT_OPAL]: 5, [CHISEL]: 1 },
    bankTabs: [{ [UNCUT_OPAL]: 100 }],
  });
  assert.equal(craftableGems(mockCrafting, p1), 5);

  const p2 = mockPlayer({
    inv: { [CHISEL]: 1 },
    bankTabs: [{ [UNCUT_OPAL]: 9 }],
  });
  assert.equal(craftableGems(mockCrafting, p2), 9);

  const p3 = mockPlayer({ inv: { [CHISEL]: 1 } });
  assert.equal(craftableGems(mockCrafting, p3), 0);
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
    hour: 12,
    ...over,
  };
}

test("decision: no gems -> score 4, never picked", () => {
  assert.equal(scoreActivity("citizen_craft", baseSnap({ gems: 0 })), 4);
});

test("decision: industrious broke trader with gems wants the chisel", () => {
  const s = scoreActivity(
    "citizen_craft",
    baseSnap({
      gems: 12,
      coins: 30,
      personality: { traits: ["dutiful", "greedy"] },
      goal: { type: "master_trade" },
    })
  );
  assert.ok(s > 50, `expected a strong craft score, got ${s}`);
});

test("decision: hurt citizen stays away from the chisel", () => {
  const s = scoreActivity("citizen_craft", baseSnap({ gems: 12, hp: 20 }));
  const well = scoreActivity("citizen_craft", baseSnap({ gems: 12 }));
  assert.ok(s < well, `hurt (${s}) should score below well (${well})`);
});
