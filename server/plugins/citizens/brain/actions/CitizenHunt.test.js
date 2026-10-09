"use strict";

/**
 * CitizenHunt unit checks — lay bird snares and trap birds for real Hunter XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenHunt".
 *   - No Hunter plugin -> "failed" (fail fast, don't stall).
 *   - Traps already active -> "running" (wait for catches).
 *   - Snares in pack, far from hunting spot -> walks to spot ("running").
 *   - Snares in pack, at hunting spot -> lays trap via startBotHunting.
 *   - No snares in pack but bank holds some -> walks to bank and withdraws.
 *   - No snares anywhere -> "success" (done, brain re-decides).
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _bestTrapKind: picks highest item-based trap at/under level.
 *   - _huntMaterials: counts pack first, bank second.
 *   - _huntingSpotFor: returns spot for trap kind.
 *   - Decision scoring: citizen_hunt scores 4 with no snares, high for an
 *     industrious broke trader with snares, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenHerb.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _hunterLevel falls back to 1 — the level-gate branches are exercised
 * through that fallback (bird eligible, box gated).
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- item ids (standard OSRS) -----------------------------------------------
const BIRD_SNARE = 10006;
const BOX_TRAP = 10008;

// --- stubs ------------------------------------------------------------------
const huntCalls = [];
const withdrawActions = [];

let mockHunter = null;

function defaultHunterMock() {
  return {
    startBotHunting: (player, kind) => {
      huntCalls.push({ player, kind });
      return true;
    },
    isHuntingActive: () => false,
    hunterLevel: () => 1,
    bestTrapKindForLevel: (level) => (level >= 27 ? "box" : "bird"),
    huntingTrapInfo: () => [
      { kind: "bird", itemId: BIRD_SNARE, level: 1 },
      { kind: "box", itemId: BOX_TRAP, level: 27 },
    ],
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
    "../../../skills/Hunter.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockHunter && prop in mockHunter) {
            return mockHunter[prop];
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
  createCitizenHuntAction,
  _huntMaterials: huntMaterials,
  _bestTrapKind: bestTrapKind,
  _trapItemId: trapItemId,
  _huntingSpotFor: huntingSpotFor,
  HUNTING_SPOTS,
} = require("./CitizenHunt");
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
      getCurrentLevel: () => {
        throw new Error("no enum in test");
      },
    }),
    getLocation: () => ({
      getX: () => playerAt.x,
      getY: () => playerAt.y,
      getZ: () => 0,
    }),
    getUsername: () => "Test Hunter",
    getAttribute: () => ({}),
    getPrivateArea: () => null,
  };
}

function mockWorld() {
  return { log: () => {} };
}

function freshAction(world) {
  huntCalls.length = 0;
  withdrawActions.length = 0;
  mockHunter = defaultHunterMock();
  return createCitizenHuntAction({}, world);
}

function ctxFor(player, nowMs = 1000) {
  return { player, nowMs, world: mockWorld() };
}

// --- tests -------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenHunt action", () => {
  const action = freshAction(mockWorld());
  assert.equal(action.id, "citizenHunt");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Hunter plugin -> failed (fail fast)", () => {
  mockHunter = null;
  const action = createCitizenHuntAction({}, mockWorld());
  const player = mockPlayer({ inv: { [BIRD_SNARE]: 3 } });
  assert.equal(action.update(ctxFor(player)), "failed");
});

test("traps already active -> running (wait for catches)", () => {
  const action = freshAction(mockWorld());
  mockHunter.isHuntingActive = () => true;
  const player = mockPlayer({ inv: { [BIRD_SNARE]: 3 } });
  assert.equal(action.update(ctxFor(player)), "running");
  assert.equal(huntCalls.length, 0); // no new trap laid
});

test("snares in pack, far from spot -> walks to hunting grounds", () => {
  const action = freshAction(mockWorld());
  // Player at (10,10), hunting spot at (1960,5897) — far away.
  const player = mockPlayer({ inv: { [BIRD_SNARE]: 3 }, playerAt: { x: 10, y: 10 } });
  assert.equal(action.update(ctxFor(player)), "running");
  assert.equal(huntCalls.length, 0); // didn't lay yet — still walking
});

test("snares in pack, at hunting spot -> lays trap via startBotHunting", () => {
  const action = freshAction(mockWorld());
  // Player at the crimson swift grounds.
  const player = mockPlayer({ inv: { [BIRD_SNARE]: 3 }, playerAt: { x: 1960, y: 5897 } });
  assert.equal(action.update(ctxFor(player)), "running");
  assert.equal(huntCalls.length, 1);
  assert.equal(huntCalls[0].kind, "bird");
});

test("no snares in pack, bank holds some -> walks to bank and withdraws", () => {
  const action = freshAction(mockWorld());
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [BIRD_SNARE]: 10 }],
    playerAt: { x: 10, y: 10 }, // far from bank at (3000,3000)
  });
  // First tick: walking to bank.
  assert.equal(action.update(ctxFor(player)), "running");
  assert.equal(withdrawActions.length, 0); // not withdrawing yet
});

test("no snares in pack, at bank with snares in bank -> withdraws", () => {
  const action = freshAction(mockWorld());
  const player = mockPlayer({
    inv: {},
    bankTabs: [{ [BIRD_SNARE]: 10 }],
    playerAt: { x: 3000, y: 3000 }, // at the bank
  });
  assert.equal(action.update(ctxFor(player)), "running");
  assert.equal(withdrawActions.length, 1);
  const spec = withdrawActions[0].spec;
  assert.ok(spec.withdraw.some((w) => w.item === BIRD_SNARE));
});

test("no snares anywhere -> success (brain re-decides)", () => {
  const action = freshAction(mockWorld());
  const player = mockPlayer({ inv: {}, bankTabs: [{}] });
  assert.equal(action.update(ctxFor(player)), "success");
});

test("give-up timeout -> success, never stalls", () => {
  const action = freshAction(mockWorld());
  const player = mockPlayer({ inv: {}, bankTabs: [{ [BIRD_SNARE]: 10 }] });
  // First tick sets giveUpAt. Jump far past it with no progress.
  action.update(ctxFor(player, 1000));
  assert.equal(action.update(ctxFor(player, 1000 + 11 * 60 * 1000)), "success");
});

test("_bestTrapKind: level 1 -> bird, level 27+ -> box", () => {
  const Hunter = defaultHunterMock();
  const lowPlayer = mockPlayer();
  Hunter.hunterLevel = () => 1;
  // bestTrapKind uses hunterLevel via the plugin mock
  assert.equal(bestTrapKind({ ...Hunter, hunterLevel: () => 1 }, lowPlayer), "bird");
  assert.equal(bestTrapKind({ ...Hunter, hunterLevel: () => 30 }, lowPlayer), "box");
});

test("_huntMaterials: counts pack first, bank second", () => {
  const Hunter = defaultHunterMock();
  const withInv = mockPlayer({ inv: { [BIRD_SNARE]: 4 } });
  assert.equal(huntMaterials(Hunter, withInv), 4);
  const withBank = mockPlayer({ inv: {}, bankTabs: [{ [BIRD_SNARE]: 7 }] });
  assert.equal(huntMaterials(Hunter, withBank), 7);
  const empty = mockPlayer({ inv: {}, bankTabs: [{}] });
  assert.equal(huntMaterials(Hunter, empty), 0);
});

test("_trapItemId: resolves item for kind", () => {
  const Hunter = defaultHunterMock();
  assert.equal(trapItemId(Hunter, "bird"), BIRD_SNARE);
  assert.equal(trapItemId(Hunter, "box"), BOX_TRAP);
  assert.equal(trapItemId(Hunter, "nope"), null);
});

test("_huntingSpotFor: returns a spot with coordinates", () => {
  const spot = huntingSpotFor("bird");
  assert.ok(Number.isInteger(spot.x));
  assert.ok(Number.isInteger(spot.y));
  assert.equal(spot.kind, "bird");
  assert.ok(HUNTING_SPOTS.length >= 1);
});

test("scoring: no snares -> 4", () => {
  const snap = {
    hp: 100, energy: 100, mood: 80, goal: null, personality: {},
    coins: 100, food: 5, freeSlots: 10, nearby: 0, logs: 0, ore: 0,
    gems: 0, rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 0, hour: 12,
  };
  assert.equal(scoreActivity("citizen_hunt", snap), 4);
});

test("scoring: snares + industrious broke trader -> high", () => {
  const snap = {
    hp: 100, energy: 100, mood: 80,
    goal: { type: "master_trade" }, personality: { industrious: 1.5 },
    coins: 30, food: 5, freeSlots: 10, nearby: 0, logs: 0, ore: 0,
    gems: 0, rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 5, hour: 12,
  };
  const s = scoreActivity("citizen_hunt", snap);
  assert.ok(s > 50, `expected high score, got ${s}`);
});

test("scoring: hurt citizen avoids hunting", () => {
  const snap = {
    hp: 30, energy: 100, mood: 80, goal: null, personality: {},
    coins: 100, food: 5, freeSlots: 10, nearby: 0, logs: 0, ore: 0,
    gems: 0, rawFood: 0, herbs: 0, fletchLogs: 0, essence: 0, hunts: 5, hour: 12,
  };
  const healthy = { ...snap, hp: 100 };
  assert.ok(
    scoreActivity("citizen_hunt", snap) < scoreActivity("citizen_hunt", healthy),
    "hurt citizen should score lower"
  );
});
