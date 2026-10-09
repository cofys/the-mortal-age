"use strict";

/**
 * CitizenTrain.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenRehearse.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenTrain.test.js
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
      if (!player.__trainState) player.__trainState = init();
      return player.__trainState;
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
    // Real seam: siteTileByKingdom(kingdomId, kind). (The old mock carried
    // a `marketTile` export that does not exist on the real CitizenSites —
    // stadiumTile() silently nulled every stadium because of it.)
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
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

const Athletics = require("../../lib/CitizenAthletics");
const SAVE_PATH = path.join(os.tmpdir(), `citizen-train-test-${process.pid}.json`);
Athletics.setSaveFile(SAVE_PATH);
const { createCitizenTrainAction } = require("./CitizenTrain");

// --- helpers ---

function stubPlayer(username, opts) {
  const o = opts || {};
  const p = {
    __trainState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => p.position,
    position: o.position || { x: 0, y: 0, z: 0 },
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
    Athletics.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

// --- tests ---

test("factory creates action with id", () => {
  const action = createCitizenTrainAction({}, {});
  assert.strictEqual(action.id, "citizenTrain");
});

test("non-athlete walks home honestly", () => {
  const action = createCitizenTrainAction({}, {});
  const player = stubPlayer("NotAnAthlete");
  const result = runTicks(action, player, 20, 1000);
  assert.strictEqual(result, "success", "should complete by walking home");
  assert(player.__movedTo, "should have moved");
});

test("athlete walks to stadium and trains", () => {
  Athletics.registerAthlete("TrainBob", "running");
  Athletics.foundStadium("asgarnia");
  const action = createCitizenTrainAction({}, {});
  // Start at stadium tile so we skip the walk
  const player = stubPlayer("TrainBob", { position: { x: 3208, y: 3200, z: 0 } });
  const before = Athletics.athleteInfo("TrainBob").fitness;
  const result = runTicks(action, player, 50, 9000); // 9s steps > 8s cooldown
  assert.strictEqual(result, "success", "should complete training");
  const after = Athletics.athleteInfo("TrainBob").fitness;
  assert(after > before, "fitness should increase from training");
});

test("athlete with no stadium walks home", () => {
  Athletics.registerAthlete("NoStadiumNed", "wrestling");
  // No stadium founded for asgarnia
  const action = createCitizenTrainAction({}, {});
  const player = stubPlayer("NoStadiumNed");
  const result = runTicks(action, player, 20, 1000);
  assert.strictEqual(result, "success", "should complete by walking home");
});

test("null player returns success", () => {
  const action = createCitizenTrainAction({}, {});
  const result = action.update({ player: null, nowMs: Date.now() });
  assert.strictEqual(result, "success");
});

test("give-up timeout forces return", () => {
  Athletics.registerAthlete("SlowSam", "running");
  Athletics.foundStadium("asgarnia");
  const action = createCitizenTrainAction({}, {});
  // Start far from stadium; nav stub teleports, but give-up still triggers
  // if we use tiny steps. Use huge step to exceed GIVE_UP_MS quickly.
  const player = stubPlayer("SlowSam", { position: { x: 0, y: 0, z: 0 } });
  // Override: don't let nav teleport (simulate stuck)
  const origNav = require.cache[navPath].exports;
  require.cache[navPath].exports = {
    requestMovement: () => {}, // stuck, no movement
    clearMovementRequest: () => {},
  };
  const result = runTicks(action, player, 15, 60 * 1000); // 15 min total > 10 min give-up
  require.cache[navPath].exports = origNav;
  assert.strictEqual(result, "success", "should give up and return home");
});

console.log(`CitizenTrain: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
