"use strict";

/**
 * CitizenFletch unit checks — cut logs into arrow shafts and bows for real
 * Fletching XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenFletch".
 *   - No Fletching plugin -> "failed" (fail fast, don't stall).
 *   - Session already active -> "running".
 *   - No logs in pack or bank -> "success" (done, brain re-decides).
 *   - Logs + knife in pack -> startBotFletching with the right count.
 *   - Logs but no knife -> "success" (can't cut without a knife).
 *   - Bank holds logs -> walks to bank and withdraws (knife included).
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _bestInventoryRecipe: picks highest-level doable recipe; level-gates.
 *   - _bestBankPlan: withdraws logs + fetches knife from bank.
 *   - _fletchMaterials: counts pack first, bank second, knife-aware.
 *   - Decision scoring: citizen_fletch scores 4 with no logs, high for an
 *     industrious broke trader with logs, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenHerb.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _fletchingLevel falls back to 1 — the level-gate branches are exercised
 * through that fallback (arrow shafts eligible, oak shortbow gated).
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard OSRS) -----------------------------------------------
const KNIFE = 946;
const LOGS = 1511;
const OAK_LOGS = 1521;
const WILLOW_LOGS = 1519;
const ARROW_SHAFT = 52;
const SHORTBOW_U = 50;
const LONGBOW_U = 48;
const OAK_SHORTBOW_U = 54;

// --- stubs ------------------------------------------------------------------
const fletchCalls = [];
const withdrawActions = [];

let mockFletching = null;

const RECIPES = [
  { name: "log:LOGS:ARROW_SHAFT", inputId: LOGS, needsId: KNIFE, outputId: ARROW_SHAFT, outputAmount: 15, level: 1, xp: 5 },
  { name: "log:LOGS:SHORTBOW_U_", inputId: LOGS, needsId: KNIFE, outputId: SHORTBOW_U, outputAmount: 1, level: 5, xp: 5 },
  { name: "log:LOGS:LONGBOW_U_", inputId: LOGS, needsId: KNIFE, outputId: LONGBOW_U, outputAmount: 1, level: 10, xp: 10 },
  { name: "log:OAK_LOGS:OAK_SHORTBOW_U_", inputId: OAK_LOGS, needsId: KNIFE, outputId: OAK_SHORTBOW_U, outputAmount: 1, level: 20, xp: 16.5 },
];

function defaultFletchingMock() {
  return {
    FLETCHING_RECIPES: RECIPES,
    startBotFletching: (player, amount) => {
      fletchCalls.push({ player, amount });
      return true;
    },
    isFletchingActive: () => false,
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
    "../../../skills/Fletching.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockFletching && prop in mockFletching) {
            return mockFletching[prop];
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
  createCitizenFletchAction,
  _fletchMaterialsFromInventory: fletchMaterialsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _fletchMaterials: fletchMaterials,
  _knifeId: knifeId,
} = require("./CitizenFletch");
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
  username = "Test_Citizen",
} = {}) {
  const tabs = bankTabs.map(mockBankTab);
  return {
    getUsername: () => username,
    getInventory: () => mockInventory(inv),
    getBank: (tab) => tabs[tab] ?? null,
    getLocation: () => ({
      getX: () => playerAt.x,
      getY: () => playerAt.y,
      getZ: () => 0,
    }),
    getAttribute: () => ({}),
    getSkillManager: () => ({
      getCurrentLevel: () => 1, // plain-node fallback: level 1
    }),
  };
}

function makeCtx(player, nowMs = 1000) {
  return { player, nowMs, world: { log: () => {} } };
}

function resetMocks() {
  mockFletching = defaultFletchingMock();
  fletchCalls.length = 0;
  withdrawActions.length = 0;
}

// --- tests -------------------------------------------------------------------

const tests = [];

function test(name, fn) {
  tests.push([name, fn]);
}

// 1. Factory returns well-formed action
test("factory returns action with id citizenFletch", () => {
  resetMocks();
  const action = createCitizenFletchAction({}, {});
  assert.equal(action.id, "citizenFletch");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

// 2. No Fletching plugin -> failed
test("fails fast when Fletching plugin missing", () => {
  mockFletching = null;
  fletchCalls.length = 0;
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({ inv: { [LOGS]: 10, [KNIFE]: 1 } });
  assert.equal(action.update(makeCtx(player)), "failed");
});

// 3. Session already active -> running
test("running while fletching session active", () => {
  resetMocks();
  mockFletching.isFletchingActive = () => true;
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({ inv: { [LOGS]: 10, [KNIFE]: 1 } });
  assert.equal(action.update(makeCtx(player)), "running");
  assert.equal(fletchCalls.length, 0); // no double-start
});

// 4. No logs anywhere -> success
test("success with no logs in pack or bank", () => {
  resetMocks();
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({ inv: { [KNIFE]: 1 }, bankTabs: [] });
  assert.equal(action.update(makeCtx(player)), "success");
});

// 5. Logs + knife in pack -> startBotFletching
test("starts bot session with log count from pack", () => {
  resetMocks();
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({ inv: { [LOGS]: 12, [KNIFE]: 1 } });
  assert.equal(action.update(makeCtx(player)), "running");
  assert.equal(fletchCalls.length, 1);
  assert.equal(fletchCalls[0].amount, 12);
});

// 6. Logs but no knife -> success (can't cut)
test("success with logs but no knife", () => {
  resetMocks();
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({ inv: { [LOGS]: 10 }, bankTabs: [] });
  assert.equal(action.update(makeCtx(player)), "success");
  assert.equal(fletchCalls.length, 0);
});

// 7. Bank holds logs -> withdraw
test("walks to bank and withdraws when bank holds logs", () => {
  resetMocks();
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({
    inv: { [KNIFE]: 1 },
    bankTabs: [{ [LOGS]: 27 }],
    playerAt: { x: 3000, y: 3000 }, // at bank
  });
  assert.equal(action.update(makeCtx(player)), "running");
  assert.equal(withdrawActions.length, 1);
  const spec = withdrawActions[0].spec;
  assert.ok(spec.withdraw.some((w) => w.item === LOGS));
});

// 8. Give-up timeout -> success
test("give-up timeout ends the action", () => {
  resetMocks();
  const action = createCitizenFletchAction({}, {});
  const player = mockPlayer({ inv: {}, bankTabs: [] });
  // First tick sets giveUpAt; far-future tick exceeds it
  action.update(makeCtx(player, 1000));
  assert.equal(action.update(makeCtx(player, 1000 + 7 * 60 * 1000)), "success");
});

// 9. _knifeId resolves from recipe table
test("_knifeId finds knife from recipes", () => {
  resetMocks();
  assert.equal(knifeId(mockFletching), KNIFE);
});

// 10. _bestInventoryRecipe picks highest-level doable
test("_bestInventoryRecipe picks best level-gated recipe", () => {
  resetMocks();
  // Level 1 (fallback): arrow shafts eligible, shortbow gated
  const player = mockPlayer({ inv: { [LOGS]: 5, [KNIFE]: 1 } });
  const recipe = bestInventoryRecipe(mockFletching, player);
  assert.ok(recipe);
  assert.equal(recipe.outputId, ARROW_SHAFT);
  assert.equal(recipe.level, 1);
});

// 11. _bestInventoryRecipe returns null without knife
test("_bestInventoryRecipe null without knife", () => {
  resetMocks();
  const player = mockPlayer({ inv: { [LOGS]: 5 } });
  assert.equal(bestInventoryRecipe(mockFletching, player), null);
});

// 12. _bestBankPlan withdraws logs and fetches knife
test("_bestBankPlan includes knife fetch when missing", () => {
  resetMocks();
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [LOGS]: 20, [KNIFE]: 1 }],
  });
  const plan = bestBankPlan(mockFletching, player);
  assert.ok(plan);
  assert.ok(plan.withdraw.some((w) => w.item === LOGS));
  assert.ok(plan.withdraw.some((w) => w.item === KNIFE));
});

// 13. _fletchMaterials counts pack first
test("_fletchMaterials counts inventory before bank", () => {
  resetMocks();
  const player = mockPlayer({
    inv: { [LOGS]: 7, [KNIFE]: 1 },
    bankTabs: [{ [LOGS]: 100 }],
  });
  assert.equal(fletchMaterials(mockFletching, player), 7);
});

// 14. _fletchMaterials falls back to bank
test("_fletchMaterials falls back to bank", () => {
  resetMocks();
  const player = mockPlayer({
    inv: { [KNIFE]: 1 },
    bankTabs: [{ [LOGS]: 15 }],
  });
  assert.equal(fletchMaterials(mockFletching, player), 15);
});

// 15. _fletchMaterials zero without knife
test("_fletchMaterials zero when no knife anywhere", () => {
  resetMocks();
  const player = mockPlayer({
    inv: { [LOGS]: 10 },
    bankTabs: [{ [LOGS]: 50 }],
  });
  assert.equal(fletchMaterials(mockFletching, player), 0);
});

// 16. Scoring: no logs -> 4
test("scoring: no logs scores 4", () => {
  resetMocks();
  assert.equal(scoreActivity("citizen_fletch", baseSnap({ fletchLogs: 0 })), 4);
});

// 17. Scoring: industrious broke trader with logs wants to fletch
test("scoring: industrious broke trader with logs wants to fletch", () => {
  resetMocks();
  const s = scoreActivity(
    "citizen_fletch",
    baseSnap({
      fletchLogs: 12,
      coins: 30,
      personality: { traits: ["dutiful", "greedy"] },
      goal: { type: "master_trade" },
    })
  );
  assert.ok(s > 50, `expected a strong fletch score, got ${s}`);
});

// 18. Scoring: hurt citizen stays away
test("scoring: hurt citizen stays away from fletching", () => {
  resetMocks();
  const s = scoreActivity("citizen_fletch", baseSnap({ fletchLogs: 12, hp: 20 }));
  const well = scoreActivity("citizen_fletch", baseSnap({ fletchLogs: 12 }));
  assert.ok(s < well, `hurt (${s}) should score below well (${well})`);
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
    fletchLogs: 0,
    hour: 12,
    ...over,
  };
}

// --- run ---------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}`);
    console.log(`  ${e.message}`);
    if (e.stack) console.log(`  ${e.stack.split("\n")[1]}`);
  }
}
console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
