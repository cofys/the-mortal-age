"use strict";

/**
 * CitizenCookOff.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenTrain.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenCookOff.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__cookState) player.__cookState = init();
      return player.__cookState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    // teleport on request: simulates the walk completing between ticks
    requestMovement: (player, tile) => { player.__movedTo = tile; player.position = { ...tile }; },
    clearMovementRequest: () => {},
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "asgarnia",
    marketTile: () => ({ x: 3200, y: 3200, level: 0 }),
  },
};

const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizens:personality" },
};

const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: () => () => 0.5,
    humanizerProfile: () => ({}),
  },
};

// --- real modules under test ---

const CookOffs = require("../../lib/CitizenCookOffs");
const SAVE_PATH = path.join(os.tmpdir(), `citizen-cookoff-action-test-${process.pid}.json`);
CookOffs.setSaveFile(SAVE_PATH);
const { createCitizenCookOffAction } = require("./CitizenCookOff");

// --- helpers ---

function stubPlayer(username, opts) {
  const o = opts || {};
  const p = {
    __cookState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => p.position,
    position: o.position || { x: 0, y: 0, z: 0 },
    getSkillManager: () => ({ getCurrentLevel: () => o.cooking || 50 }),
  };
  return p;
}

function runTicks(action, player, ticks, stepMs) {
  let nowMs = Date.now();
  let result = "running";
  for (let i = 0; i < ticks && result === "running"; i++) {
    nowMs += stepMs;
    result = action.update({ player, nowMs });
  }
  return result;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    CookOffs.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

// --- tests ---

test("factory creates action with id", () => {
  const action = createCitizenCookOffAction({}, {});
  assert.strictEqual(action.id, "citizenCookOff");
});

test("non-entrant walks home honestly", () => {
  CookOffs.scheduleCookOff("asgarnia", Date.now());
  const action = createCitizenCookOffAction({}, {});
  const player = stubPlayer("NotEntered");
  const result = runTicks(action, player, 20, 1000);
  assert.strictEqual(result, "success", "should complete by walking home");
  assert(player.__movedTo, "should have moved");
});

test("entrant walks to venue and cooks all 3 rounds", () => {
  const co = CookOffs.scheduleCookOff("asgarnia", Date.now());
  CookOffs.enterCookOff(co.id, "ChefBob", () => true, Date.now());
  const action = createCitizenCookOffAction({}, {});
  // Start at venue tile (market +4,+4) so we skip the walk
  const player = stubPlayer("ChefBob", {
    position: { x: 3204, y: 3204, z: 0 },
    cooking: 70,
    personality: { creativity: 0.8 },
  });
  const result = runTicks(action, player, 60, 9000); // 9s steps > 8s cooldown
  assert.strictEqual(result, "success", "should complete the cook-off");
  const entry = CookOffs.cookOffById(co.id).entries.find((e) => e.chef === "ChefBob");
  assert.ok(entry, "entry exists");
  assert.strictEqual(Object.keys(entry.rounds).length, 3, "all 3 rounds scored");
  for (const r of CookOffs.ROUNDS) {
    assert.ok(entry.rounds[r] >= 1 && entry.rounds[r] <= 100, `round ${r} scored 1-100`);
  }
});

test("entrant with no open cook-off walks home", () => {
  // No cook-off scheduled at all.
  const action = createCitizenCookOffAction({}, {});
  const player = stubPlayer("ChefLonely");
  const result = runTicks(action, player, 20, 1000);
  assert.strictEqual(result, "success", "should complete by walking home");
});

test("null player returns success", () => {
  const action = createCitizenCookOffAction({}, {});
  const result = action.update({ player: null, nowMs: Date.now() });
  assert.strictEqual(result, "success");
});

test("give-up timeout forces return", () => {
  const co = CookOffs.scheduleCookOff("asgarnia", Date.now());
  CookOffs.enterCookOff(co.id, "SlowSam", () => true, Date.now());
  const action = createCitizenCookOffAction({}, {});
  const player = stubPlayer("SlowSam", { position: { x: 0, y: 0, z: 0 } });
  const origNav = require.cache[navPath].exports;
  require.cache[navPath].exports = {
    requestMovement: () => {}, // stuck, no movement
    clearMovementRequest: () => {},
  };
  const result = runTicks(action, player, 15, 60 * 1000); // 15 min > 10 min give-up
  require.cache[navPath].exports = origNav;
  assert.strictEqual(result, "success", "should give up and return home");
});

console.log(`CitizenCookOff: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
