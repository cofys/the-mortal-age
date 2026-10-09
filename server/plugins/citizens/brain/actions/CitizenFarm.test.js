"use strict";

/**
 * CitizenFarm unit checks — run real farming routes for real Farming XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenFarm".
 *   - No farming plugin (botFarm missing) -> "failed" (fail fast, don't stall).
 *   - No seeds anywhere (but tools present) -> "success" (re-decide).
 *   - Seeds in pack but no patches in walking range -> "success".
 *   - Seeds in pack, patches in range, far away -> walks to patch ("running").
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _farmingLevel: falls back to 1 when the Skill enum is unavailable.
 *   - _bestSeedFor: picks the highest level-eligible seed with enough count.
 *   - _seedCounts: counts pack first, bank second; level-gates seeds.
 *   - _bestBankPlan: missing tools + best bank seeds + compost; null when
 *     the bank can't supply anything needed.
 *   - _nearestPatchCluster: nearest patch anchors the site, herb first.
 *   - _patchWork: dead -> dig, weeds -> rake, empty raked -> compost/plant,
 *     grown unchecked -> check, grown checked -> harvest.
 *   - _waterCanId / _compostTier helpers.
 *   - Decision scoring: citizen_farm scores 4 with no seeds, high for an
 *     industrious broke saver with seeds, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenHunt.test.js) so plain-node tests stay engine-free. The engine
 * Skill enum (a .ts source) is unavailable in plain node, so _farmingLevel
 * falls back to 1 — the level-gate branches are exercised through that
 * fallback.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard OSRS) -----------------------------------------------
const RAKE = 5341;
const SEED_DIBBER = 5343;
const SPADE = 952;
const WATERING_CAN_8 = 5340;
const COMPOST = 6032;
const SUPERCOMPOST = 6034;
const GUAM_SEED = 5291; // herb, level 9
const POTATO_SEED = 5318; // allotment, level 1
const MARIGOLD_SEED = 5096; // flower, level 2
const RANARR_SEED = 5295; // herb, level 32

// --- stubs ------------------------------------------------------------------
const engineCalls = [];
const withdrawActions = [];

let mockFarming = null;

function defaultFarmingMock() {
  const seeds = new Map([
    [GUAM_SEED, { type: "HERB", level: 9, seedCount: 1 }],
    [POTATO_SEED, { type: "ALLOTMENT", level: 1, seedCount: 3 }],
    [MARIGOLD_SEED, { type: "FLOWER", level: 2, seedCount: 1 }],
    [RANARR_SEED, { type: "HERB", level: 32, seedCount: 1 }],
  ]);
  const crops = new Map([
    ["guam", { type: "HERB", check: true }],
    ["potato", { type: "ALLOTMENT", check: false }],
  ]);
  const patches = [
    { id: 1, type: "HERB", x: 3050, y: 3050, z: 0 },
    { id: 2, type: "ALLOTMENT", x: 3055, y: 3052, z: 0 },
    { id: 3, type: "FLOWER", x: 3045, y: 3048, z: 0 },
  ];
  const itemIds = {
    Rake: RAKE,
    "Seed dibber": SEED_DIBBER,
    Spade: SPADE,
    "Watering can(8)": WATERING_CAN_8,
    Compost: COMPOST,
    Supercompost: SUPERCOMPOST,
    Ultracompost: 6033,
  };
  // patch state keyed by patch id — tests mutate this
  const patchStates = new Map();
  return {
    plant: (player, patch, id) => {
      engineCalls.push({ op: "plant", patch: patch.id, id });
      return true;
    },
    rake: (player, patch) => {
      engineCalls.push({ op: "rake", patch: patch.id });
      return true;
    },
    waterPatch: (player, patch, id) => {
      engineCalls.push({ op: "water", patch: patch.id, id });
      return true;
    },
    healthCheck: (player, patch) => {
      engineCalls.push({ op: "check", patch: patch.id });
      return true;
    },
    harvest: (player, patch) => {
      engineCalls.push({ op: "harvest", patch: patch.id });
      return true;
    },
    dig: (player, patch) => {
      engineCalls.push({ op: "dig", patch: patch.id });
      return true;
    },
    fertilize: (player, patch, tier, consume) => {
      engineCalls.push({ op: "fertilize", patch: patch.id, tier });
      return true;
    },
    stateFor: (player, patch) => patchStates.get(patch.id) ?? null,
    farmFor: () => ({}),
    hasTool: (player, name) => {
      const id = itemIds[name];
      return id !== undefined && (player.getInventory?.().getAmount?.(id) ?? 0) > 0;
    },
    requireTool: () => true,
    nearPatch: () => true,
    advanceFarm: () => {},
    patches,
    seeds,
    crops,
    waterable: new Set(["ALLOTMENT", "FLOWER", "HOPS"]),
    itemId: (name) => itemIds[name] ?? -1,
    _patchStates: patchStates,
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
    "../../../skills/farming/Patches.Farming": new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "botFarm") return mockFarming;
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
  createCitizenFarmAction,
  _farmingLevel: farmingLevel,
  _bestSeedFor: bestSeedFor,
  _seedCounts: seedCounts,
  _bestBankPlan: bestBankPlan,
  _nearestPatchCluster: nearestPatchCluster,
  _patchWork: patchWork,
  _waterCanId: waterCanId,
  _compostTier: compostTier,
} = require("./CitizenFarm");
const { scoreActivity, ACT_FARM } = require("../CitizenDecisions");

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
      getCurrentLevel: () => {
        throw new Error("no enum in test");
      },
    }),
    getLocation: () => ({
      getX: () => playerAt.x,
      getY: () => playerAt.y,
      getZ: () => 0,
    }),
    getUsername: () => "Test Farmer",
    getAttribute: () => ({}),
    getPrivateArea: () => null,
  };
}

function mockWorld() {
  return { log: () => {} };
}

function freshAction(world) {
  engineCalls.length = 0;
  withdrawActions.length = 0;
  mockFarming = defaultFarmingMock();
  return createCitizenFarmAction({}, world);
}

function ctxFor(player, nowMs = 1000) {
  return { player, nowMs, world: mockWorld() };
}

function toolsInv() {
  return { [RAKE]: 1, [SEED_DIBBER]: 1, [SPADE]: 1 };
}

// --- tests -------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenFarm action", () => {
  const action = freshAction(mockWorld());
  assert.equal(action.id, "citizenFarm");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no farming plugin -> failed (fail fast)", () => {
  mockFarming = null;
  const action = createCitizenFarmAction({}, mockWorld());
  const player = mockPlayer({ inv: { ...toolsInv(), [POTATO_SEED]: 3 } });
  assert.equal(action.update(ctxFor(player)), "failed");
});

test("no seeds anywhere -> success (re-decide)", () => {
  const action = freshAction(mockWorld());
  const player = mockPlayer({ inv: toolsInv(), playerAt: { x: 3050, y: 3050 } });
  assert.equal(action.update(ctxFor(player)), "success");
});

test("seeds in pack but no patches in range -> success", () => {
  const action = freshAction(mockWorld());
  // player far from the mock patches (3050,3050 area)
  const player = mockPlayer({
    inv: { ...toolsInv(), [POTATO_SEED]: 3 },
    playerAt: { x: 100, y: 100 },
  });
  assert.equal(action.update(ctxFor(player)), "success");
});

test("seeds in pack, patches in range, far away -> walks (running)", () => {
  const action = freshAction(mockWorld());
  // within search radius (250) but outside arrive radius (12) of nearest patch
  const player = mockPlayer({
    inv: { ...toolsInv(), [POTATO_SEED]: 3 },
    playerAt: { x: 3100, y: 3100 },
  });
  const result = action.update(ctxFor(player));
  assert.equal(result, "running");
});

test("give-up timeout -> success, never stalls", () => {
  const action = freshAction(mockWorld());
  const player = mockPlayer({
    inv: { ...toolsInv(), [POTATO_SEED]: 3 },
    playerAt: { x: 3100, y: 3100 },
  });
  // first tick sets giveUpAt = nowMs + 12min; jump past it
  action.update(ctxFor(player, 1000));
  assert.equal(action.update(ctxFor(player, 1000 + 13 * 60 * 1000)), "success");
});

test("_farmingLevel falls back to 1 without the Skill enum", () => {
  const player = mockPlayer();
  assert.equal(farmingLevel(player), 1);
});

test("_bestSeedFor picks highest level-eligible seed with enough count", () => {
  mockFarming = defaultFarmingMock();
  // level 1 fallback: only potato (lvl 1, needs 3) and marigold (lvl 2, gated)
  const player = mockPlayer({ inv: { [POTATO_SEED]: 3, [GUAM_SEED]: 5 } });
  const best = bestSeedFor(mockFarming, player, "ALLOTMENT");
  assert.ok(best);
  assert.equal(best.seedId, POTATO_SEED);
  // not enough seeds -> skipped
  const poor = mockPlayer({ inv: { [POTATO_SEED]: 2 } });
  assert.equal(bestSeedFor(mockFarming, poor, "ALLOTMENT"), null);
  // guam is level 9, gated at fallback level 1
  assert.equal(bestSeedFor(mockFarming, player, "HERB"), null);
});

test("_seedCounts counts pack first, bank second, level-gates", () => {
  mockFarming = defaultFarmingMock();
  const player = mockPlayer({
    inv: { [POTATO_SEED]: 3 },
    bankTabs: [{ [GUAM_SEED]: 10, [RANARR_SEED]: 4 }],
  });
  const counts = seedCounts(mockFarming, player);
  // level 1: potato in pack counts; guam/ranarr gated out everywhere
  assert.equal(counts.inv, 3);
  assert.equal(counts.bank, 0);
  const empty = mockPlayer({ bankTabs: [{ [POTATO_SEED]: 12 }] });
  const counts2 = seedCounts(mockFarming, empty);
  assert.equal(counts2.inv, 0);
  assert.equal(counts2.bank, 12);
});

test("_bestBankPlan covers tools, seeds, compost; null when bank is bare", () => {
  mockFarming = defaultFarmingMock();
  // missing spade + seeds in bank
  const player = mockPlayer({
    inv: { [RAKE]: 1, [SEED_DIBBER]: 1 },
    bankTabs: [{ [SPADE]: 1, [POTATO_SEED]: 12, [COMPOST]: 5 }],
  });
  const plan = bestBankPlan(mockFarming, player);
  assert.ok(plan);
  const items = plan.withdraw.map((w) => w.item);
  assert.ok(items.includes(SPADE), "withdraws missing spade");
  assert.ok(items.includes(POTATO_SEED), "withdraws bank seeds");
  assert.ok(items.includes(COMPOST), "withdraws compost");
  // bank has nothing useful -> null
  const bare = mockPlayer({ inv: { [RAKE]: 1 }, bankTabs: [{}] });
  assert.equal(bestBankPlan(mockFarming, bare), null);
});

test("_nearestPatchCluster anchors on nearest, herb first", () => {
  mockFarming = defaultFarmingMock();
  const player = mockPlayer({ playerAt: { x: 3050, y: 3050 } });
  const site = nearestPatchCluster(mockFarming, player);
  assert.ok(Array.isArray(site));
  assert.equal(site.length, 3);
  assert.equal(site[0].type, "HERB", "herb patch worked first");
  // far away -> null
  const far = mockPlayer({ playerAt: { x: 100, y: 100 } });
  assert.equal(nearestPatchCluster(mockFarming, far), null);
});

test("_patchWork: dead -> dig, weeds -> rake, empty -> compost/plant, grown -> check/harvest", () => {
  mockFarming = defaultFarmingMock();
  const states = mockFarming._patchStates;
  const herbPatch = mockFarming.patches[0];
  const player = mockPlayer({ inv: { ...toolsInv(), [COMPOST]: 2, [GUAM_SEED]: 5 } });

  states.set(herbPatch.id, { crop: "guam", status: "dead", weeds: 0 });
  assert.equal(patchWork(mockFarming, player, herbPatch).kind, "dig");

  states.set(herbPatch.id, { crop: null, weeds: 3 });
  assert.equal(patchWork(mockFarming, player, herbPatch).kind, "rake");

  states.set(herbPatch.id, { crop: null, weeds: 0, compost: false });
  assert.equal(patchWork(mockFarming, player, herbPatch).kind, "compost");

  const noCompost = mockPlayer({ inv: { ...toolsInv(), [POTATO_SEED]: 3 } });
  const allotPatch = mockFarming.patches[1];
  states.set(allotPatch.id, { crop: null, weeds: 0, compost: true });
  const plantWork = patchWork(mockFarming, noCompost, allotPatch);
  assert.equal(plantWork.kind, "plant");
  assert.equal(plantWork.seed.seedId, POTATO_SEED);

  states.set(herbPatch.id, { crop: "guam", status: "grown", checked: false });
  assert.equal(patchWork(mockFarming, player, herbPatch).kind, "check");

  states.set(herbPatch.id, { crop: "guam", status: "grown", checked: true });
  assert.equal(patchWork(mockFarming, player, herbPatch).kind, "harvest");

  // growing crop, nothing to do
  states.set(herbPatch.id, { crop: "guam", status: "growing" });
  assert.equal(patchWork(mockFarming, player, herbPatch), null);
});

test("_waterCanId finds a water-holding can, -1 when none", () => {
  mockFarming = defaultFarmingMock();
  const player = mockPlayer({ inv: { [WATERING_CAN_8]: 1 } });
  assert.equal(waterCanId(mockFarming, player), WATERING_CAN_8);
  const dry = mockPlayer({ inv: {} });
  assert.equal(waterCanId(mockFarming, dry), -1);
});

test("_compostTier maps compost names to engine tiers", () => {
  mockFarming = defaultFarmingMock();
  assert.equal(compostTier(mockFarming, mockPlayer(), COMPOST), 1);
  assert.equal(compostTier(mockFarming, mockPlayer(), SUPERCOMPOST), 2);
});

test("scoring: no seeds -> 4", () => {
  const snap = {
    hp: 100, energy: 100, mood: 80, goal: null, personality: {},
    coins: 100, food: 5, freeSlots: 10, nearby: 0, logs: 0, ore: 0,
    gems: 0, rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 0,
    seeds: 0, hour: 12,
  };
  assert.equal(scoreActivity(ACT_FARM, snap), 4);
});

test("scoring: seeds + industrious broke saver -> high", () => {
  const snap = {
    hp: 100, energy: 100, mood: 80,
    goal: { type: "save_gold" }, personality: { traits: ["dutiful", "methodical"] },
    coins: 30, food: 5, freeSlots: 10, nearby: 0, logs: 0, ore: 0,
    gems: 0, rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 0,
    seeds: 8, hour: 12,
  };
  const s = scoreActivity(ACT_FARM, snap);
  assert.ok(s > 50, `expected high farm score, got ${s}`);
});

test("scoring: hurt citizen avoids farming", () => {
  const snap = {
    hp: 30, energy: 100, mood: 80, goal: null, personality: {},
    coins: 100, food: 5, freeSlots: 10, nearby: 0, logs: 0, ore: 0,
    gems: 0, rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 0,
    seeds: 8, hour: 12,
  };
  const healthy = { ...snap, hp: 100 };
  assert.ok(
    scoreActivity(ACT_FARM, snap) < scoreActivity(ACT_FARM, healthy),
    "hurt citizen should score lower"
  );
});
