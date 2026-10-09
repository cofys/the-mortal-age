"use strict";

/**
 * CitizenBuild unit checks — carpentry: build real furniture from real
 * planks for real Construction XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenBuild".
 *   - No Construction plugin -> "failed" (fail fast, don't stall).
 *   - Inventory full -> walks to bank and deposits.
 *   - Pack has planks + nails + tools -> builds via buildFurnitureBot
 *     ("running"), human-paced by BUILD_COOLDOWN_MS.
 *   - Pack dry, bank has planks -> walks to bank and withdraws.
 *   - Nothing buildable anywhere -> "success" (done, brain re-decides).
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _buildLevel: falls back to 1 when the plugin can't read it.
 *   - _hasTools: hammer + saw both required.
 *   - _bestBankPlan: picks the best level-gated recipe the bank can
 *     supply, matches nails, fetches missing tools.
 *   - Decision scoring: citizen_build scores with timber on hand,
 *     boosted for broke carpenters and home-furnishers; penalized when
 *     hurt/exhausted; 4 with nothing to build.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenThieve.test.js) so plain-node tests stay engine-free.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- stubs ------------------------------------------------------------------
const buildCalls = [];
const bankActions = [];
const moveRequests = [];

let mockConstruction = null;

const MOCK_RECIPES = [
  {
    key: "CRUDE_WOODEN_CHAIR",
    name: "crude wooden chair",
    level: 1,
    xp: 58,
    itemId: 8309,
    materials: [
      [960, 2],
      [4819, 2],
    ],
  },
  {
    key: "OAK_CHAIR",
    name: "oak chair",
    level: 19,
    xp: 120,
    itemId: 8312,
    materials: [[8778, 2]],
  },
];

function defaultConstructionMock(level = 1) {
  return {
    CONSTRUCTION_RECIPES: MOCK_RECIPES,
    HAMMER_ID: 2347,
    SAW_ID: 8794,
    NAIL_ID: 4819,
    PLANK_IDS: [960, 8778, 8780, 8782],
    constructionLevel: () => level,
    findBestBuildable: (player) => {
      const inv = player.getInventory();
      const has = (id, n) => inv.getAmount(id) >= n;
      if (!has(2347, 1) || !has(8794, 1)) return null;
      for (const r of [...MOCK_RECIPES].sort((a, b) => b.level - a.level)) {
        if (r.level > level) continue;
        if (r.materials.every(([id, n]) => has(id, n))) return r;
      }
      return null;
    },
    buildFurnitureBot: (player, key) => {
      buildCalls.push({ player, key });
      const r = MOCK_RECIPES.find((x) => x.key === key);
      if (!r) return { ok: false, reason: "unknown-recipe" };
      return { ok: true, xp: r.xp, itemId: r.itemId };
    },
  };
}

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y, opts) => {
        moveRequests.push({ player, x, y, opts });
        return true;
      },
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
        bankActions.push(delegate);
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
    "../../lib/CitizenHomes": {
      homeOf: () => null,
    },
    "../../../skills/Construction.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockConstruction && prop in mockConstruction) {
            return mockConstruction[prop];
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
  createCitizenBuildAction,
  _buildLevel: buildLevel,
  _hasTools: hasTools,
  _bestBankPlan: bestBankPlan,
  _buildableFurniture: buildableFurniture,
  BUILD_COOLDOWN_MS,
  GIVE_UP_MS,
} = require("./CitizenBuild");
const { scoreActivity } = require("../CitizenDecisions");

// --- mock players ------------------------------------------------------------

function mockInventory({ full = false, items = {} } = {}) {
  const stock = { ...items };
  return {
    isFull: () => full,
    getAmount: (id) => stock[id] ?? 0,
    getFreeSlots: () => (full ? 0 : 20),
    contains: (id) => (stock[id] ?? 0) > 0,
    addItem: () => {},
    deleteNumber: (id, n) => {
      stock[id] = Math.max(0, (stock[id] ?? 0) - n);
    },
  };
}

function mockBankTabs(tabs) {
  return tabs.map((stock) => {
    const ids = Object.keys(stock).map(Number);
    return {
      getSlotForItemId: (id) => ids.indexOf(Number(id)),
      getItems: () =>
        ids.map((id) => ({
          getId: () => id,
          getAmount: () => stock[id],
        })),
    };
  });
}

function mockPlayer({
  invFull = false,
  packItems = {},
  bankTabs = [],
  playerAt = { x: 10, y: 10 },
} = {}) {
  const inv = mockInventory({ full: invFull, items: packItems });
  const tabs = mockBankTabs(bankTabs);
  return {
    getInventory: () => inv,
    getBank: (tab) => tabs[tab] ?? null,
    getLocation: () => ({
      getX: () => playerAt.x,
      getY: () => playerAt.y,
      getZ: () => 0,
    }),
    getUsername: () => "Test Carpenter",
    getAttribute: () => ({}),
  };
}

function mockWorld() {
  return { log: () => {} };
}

function freshAction(world) {
  const spec = {};
  return createCitizenBuildAction(spec, world);
}

function resetMocks() {
  buildCalls.length = 0;
  bankActions.length = 0;
  moveRequests.length = 0;
  mockConstruction = defaultConstructionMock(1);
}

// --- tests -------------------------------------------------------------------

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("factory returns an action with id citizenBuild", () => {
  resetMocks();
  const action = freshAction(mockWorld());
  assert.equal(action.id, "citizenBuild");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Construction plugin -> failed", () => {
  resetMocks();
  mockConstruction = null; // Proxy returns undefined for everything
  const action = freshAction(mockWorld());
  const player = mockPlayer();
  const result = action.update({ player, nowMs: 1000, world: mockWorld() });
  assert.equal(result, "failed");
});

test("inventory full -> walks to bank and deposits", () => {
  resetMocks();
  const action = freshAction(mockWorld());
  // Player far from the bank (3000,3000) with a full pack.
  const player = mockPlayer({ invFull: true, playerAt: { x: 10, y: 10 } });
  const r1 = action.update({ player, nowMs: 1000, world: mockWorld() });
  assert.equal(r1, "running");
  assert.ok(moveRequests.length > 0, "expected a walk-to-bank movement");
  // Arrive at the bank: deposit delegate created.
  const atBank = mockPlayer({ invFull: true, playerAt: { x: 3000, y: 3000 } });
  const r2 = action.update({ player: atBank, nowMs: 2000, world: mockWorld() });
  assert.equal(r2, "running");
  assert.ok(bankActions.length > 0, "expected a bank deposit delegate");
  assert.equal(bankActions[0].spec.deposit, "all");
});

test("pack has materials + tools -> builds via buildFurnitureBot", () => {
  resetMocks();
  const action = freshAction(mockWorld());
  const player = mockPlayer({
    packItems: { 2347: 1, 8794: 1, 960: 6, 4819: 6 },
  });
  const r1 = action.update({ player, nowMs: 1000, world: mockWorld() });
  assert.equal(r1, "running");
  assert.equal(buildCalls.length, 1, "expected one build");
  assert.equal(buildCalls[0].key, "CRUDE_WOODEN_CHAIR");
  // Cooldown: immediate next tick does not build again.
  const r2 = action.update({ player, nowMs: 1000 + BUILD_COOLDOWN_MS - 1, world: mockWorld() });
  assert.equal(r2, "running");
  assert.equal(buildCalls.length, 1, "cooldown should pace builds");
  // After the cooldown, it builds again.
  const r3 = action.update({ player, nowMs: 1000 + BUILD_COOLDOWN_MS + 1, world: mockWorld() });
  assert.equal(r3, "running");
  assert.equal(buildCalls.length, 2, "expected a second build after cooldown");
});

test("pack dry, bank has planks -> withdraws from bank", () => {
  resetMocks();
  const action = freshAction(mockWorld());
  // Empty pack, far from bank, bank holds planks + nails + tools.
  const player = mockPlayer({
    playerAt: { x: 10, y: 10 },
    bankTabs: [{ 960: 100, 4819: 100, 2347: 1, 8794: 1 }],
  });
  const r1 = action.update({ player, nowMs: 1000, world: mockWorld() });
  assert.equal(r1, "running");
  assert.ok(moveRequests.length > 0, "expected a walk-to-bank movement");
  // At the bank: withdraw delegate created with planks + nails + tools.
  const atBank = mockPlayer({
    playerAt: { x: 3000, y: 3000 },
    bankTabs: [{ 960: 100, 4819: 100, 2347: 1, 8794: 1 }],
  });
  const r2 = action.update({ player: atBank, nowMs: 2000, world: mockWorld() });
  assert.equal(r2, "running");
  assert.ok(bankActions.length > 0, "expected a bank withdraw delegate");
  const items = bankActions[0].spec.withdraw.map((w) => w.item);
  assert.ok(items.includes(960), "withdraws planks");
  assert.ok(items.includes(4819), "withdraws nails");
  assert.ok(items.includes(2347), "fetches a hammer");
  assert.ok(items.includes(8794), "fetches a saw");
});

test("nothing buildable anywhere -> success", () => {
  resetMocks();
  const action = freshAction(mockWorld());
  const player = mockPlayer({ bankTabs: [] }); // empty pack, empty bank
  const result = action.update({ player, nowMs: 1000, world: mockWorld() });
  assert.equal(result, "success");
});

test("give-up timeout -> success", () => {
  resetMocks();
  const action = freshAction(mockWorld());
  const player = mockPlayer({
    packItems: { 2347: 1, 8794: 1, 960: 6, 4819: 6 },
  });
  action.update({ player, nowMs: 1000, world: mockWorld() });
  const result = action.update({
    player,
    nowMs: 1000 + GIVE_UP_MS + 1,
    world: mockWorld(),
  });
  assert.equal(result, "success");
});

test("_buildLevel falls back to 1 when the plugin can't read it", () => {
  resetMocks();
  mockConstruction = { constructionLevel: null };
  const player = mockPlayer();
  assert.equal(buildLevel(player), 1);
});

test("_hasTools requires both hammer and saw", () => {
  resetMocks();
  assert.equal(hasTools(mockPlayer({ packItems: { 2347: 1, 8794: 1 } }), mockConstruction), true);
  assert.equal(hasTools(mockPlayer({ packItems: { 2347: 1 } }), mockConstruction), false);
  assert.equal(hasTools(mockPlayer({ packItems: { 8794: 1 } }), mockConstruction), false);
  assert.equal(hasTools(mockPlayer({}), mockConstruction), false);
});

test("_bestBankPlan picks the best level-gated recipe the bank can supply", () => {
  resetMocks();
  mockConstruction = defaultConstructionMock(19); // oak unlocked
  const player = mockPlayer({ bankTabs: [{ 960: 100, 8778: 50, 4819: 100 }] });
  const plan = bestBankPlan(mockConstruction, player);
  assert.ok(plan, "expected a plan");
  assert.equal(plan.recipe.key, "OAK_CHAIR", "best level-gated recipe wins");
  const plankWithdraw = plan.withdraw.find((w) => w.item === 8778);
  assert.ok(plankWithdraw && plankWithdraw.amount > 0, "withdraws oak planks");
  // Level 1 carpenter gets the crude chair even with oak in the bank.
  mockConstruction = defaultConstructionMock(1);
  const plan2 = bestBankPlan(mockConstruction, player);
  assert.ok(plan2, "expected a plan");
  assert.equal(plan2.recipe.key, "CRUDE_WOODEN_CHAIR");
  assert.ok(plan2.withdraw.some((w) => w.item === 4819), "matches nails");
});

test("_buildableFurniture prefers the pack, falls back to the bank", () => {
  resetMocks();
  const withPack = mockPlayer({ packItems: { 2347: 1, 8794: 1, 960: 4, 4819: 4 } });
  assert.equal(buildableFurniture(mockConstruction, withPack).key, "CRUDE_WOODEN_CHAIR");
  const bankOnly = mockPlayer({ bankTabs: [{ 960: 100, 4819: 100 }] });
  assert.equal(buildableFurniture(mockConstruction, bankOnly).key, "CRUDE_WOODEN_CHAIR");
  const nothing = mockPlayer({});
  assert.equal(buildableFurniture(mockConstruction, nothing), null);
});

test("scoring: citizen_build wants timber, pays the broke, favors home-furnishers", () => {
  resetMocks();
  const base = {
    hp: 100, energy: 80, mood: 60,
    goal: null, personality: {}, coins: 500,
    food: 5, freeSlots: 10, nearby: 2, logs: 0, ore: 0, gems: 0,
    rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 0, seeds: 0,
    thiefLevel: 1, builds: 10, buildLevel: 1, homeFurnishable: false, hour: 12,
  };
  const withTimber = scoreActivity("citizen_build", base);
  assert.ok(withTimber > 30, `expected a working score, got ${withTimber}`);
  const broke = scoreActivity("citizen_build", { ...base, coins: 10 });
  assert.ok(broke > withTimber, "broke carpenters grind harder");
  const furnisher = scoreActivity("citizen_build", { ...base, homeFurnishable: true });
  assert.ok(furnisher > withTimber, "home-furnishers lean in");
  const veteran = scoreActivity("citizen_build", { ...base, buildLevel: 40 });
  assert.ok(veteran > withTimber, "oak-tier veterans lean in");
  const none = scoreActivity("citizen_build", { ...base, builds: 0 });
  assert.equal(none, 4, "no timber anywhere -> baseline 4");
  const hurt = scoreActivity("citizen_build", { ...base, hp: 10 });
  assert.ok(hurt < withTimber, "hurt citizens stay away from the workbench");
  const exhausted = scoreActivity("citizen_build", { ...base, energy: 2 });
  assert.ok(exhausted < withTimber, "exhausted citizens stay away");
});

// --- runner ------------------------------------------------------------------
let passed = 0;
let failed = 0;

// Wiring: the activity is registered in the JSON and the action type is
// wired in CitizenActionTypes (mirrors CitizenChop.test.js).
const fs = require("node:fs");
try {
  const data = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "data", "citizen-activities.json"),
      "utf8"
    )
  );
  const build = data.activities.find((a) => a.id === "citizen_build");
  assert.ok(build, "citizen_build activity must exist");
  assert.equal(build.mode, "citizen_build");
  assert.deepEqual(
    build.actions.map((a) => a.type),
    ["citizenBuild"]
  );
  assert.ok(
    build.requires?.[0]?.citizen?.roles?.includes("commoner"),
    "commoners can build"
  );
  const actionTypesSrc = fs.readFileSync(
    path.join(__dirname, "..", "CitizenActionTypes.js"),
    "utf8"
  );
  assert.ok(
    actionTypesSrc.includes('registerBotActionType("citizenBuild"'),
    "citizenBuild action type must be registered"
  );
  passed += 1;
  console.log("ok - citizen_build activity is wired (json + action types)");
} catch (err) {
  failed += 1;
  console.log("FAIL - citizen_build activity is wired (json + action types)");
  console.log(err.stack ?? String(err));
}

for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL - ${name}`);
    console.log(err.stack ?? String(err));
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
