"use strict";

/**
 * CitizenRehearse.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenExcavate.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenRehearse.test.js
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
      if (!player.__rehearseState) player.__rehearseState = init();
      return player.__rehearseState;
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
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "asgarnia",
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

const Theater = require("../../lib/CitizenTheater");
Theater._setSavePathForTests(path.join(os.tmpdir(), `citizen-rehearse-test-${process.pid}.json`));
const SAVE_PATH = path.join(os.tmpdir(), `citizen-rehearse-test-${process.pid}.json`);
const { createCitizenRehearseAction } = require("./CitizenRehearse");

// --- helpers ---

function stubPlayer(username, opts) {
  const o = opts || {};
  const p = {
    __rehearseState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => p.position,
    position: o.position || { x: 0, y: 0, z: 0 },
    performEmote: () => {},
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
    Theater.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

test("factory creates the action", () => {
  const action = createCitizenRehearseAction({}, {});
  assert.strictEqual(action.id, "citizenRehearse");
  assert.strictEqual(typeof action.update, "function");
});

test("non-troupe members walk home honestly", () => {
  const action = createCitizenRehearseAction({}, {});
  const p = stubPlayer("Lonely", { position: { x: 3200, y: 3200, z: 0 } });
  const result = runTicks(action, p, 20, 1000);
  assert.strictEqual(result, "success", "non-member finishes by going home");
});

test("troupe members walk to the theater", () => {
  Theater.formTroupe("Alice", "asgarnia", "Asgarnia Players");
  const action = createCitizenRehearseAction({}, {});
  const p = stubPlayer("Alice", { position: { x: 0, y: 0, z: 0 } });
  runTicks(action, p, 3, 1000);
  assert(p.__movedTo, "troupe member walks somewhere");
  assert.strictEqual(p.__rehearseState.troupeName, "Asgarnia Players");
});

test("rehearsal completes after rounds", () => {
  Theater.formTroupe("Alice", "asgarnia", "Asgarnia Players");
  const action = createCitizenRehearseAction({}, {});
  // start AT the theater tile so we go straight to rehearsing
  const p = stubPlayer("Alice", { position: { x: 3176, y: 3224, z: 0 } });
  const result = runTicks(action, p, 60, 9000);
  assert.strictEqual(result, "success", "rehearsal finishes");
  assert(p.__rehearseState.roundsDone >= 3, "rounds were rehearsed");
});

test("null player is safe", () => {
  const action = createCitizenRehearseAction({}, {});
  assert.strictEqual(action.update({ player: null, nowMs: Date.now() }), "success");
});

test("give-up timeout sends the citizen home", () => {
  Theater.formTroupe("Alice", "asgarnia", "Asgarnia Players");
  const action = createCitizenRehearseAction({}, {});
  // far away, never arrives — should give up and head home
  const p = stubPlayer("Alice", { position: { x: 0, y: 0, z: 0 } });
  // stub movement to never arrive: keep position far
  const result = runTicks(action, p, 700, 60 * 1000);
  assert.strictEqual(result, "success", "gives up and goes home");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
