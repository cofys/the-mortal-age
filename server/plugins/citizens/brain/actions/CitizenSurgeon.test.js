"use strict";

/**
 * CitizenSurgeon.test.js — brain action tests for the surgeon.
 *
 * Plain node:assert. Mocks the action's engine dependencies.
 * Run with: node <this file>.
 */

const assert = require("node:assert");
const path = require("node:path");

// --- mock engine modules before the action loads ---
const actionStatePath = require.resolve("../../../bots/brain/ActionState");
require.cache[actionStatePath] = {
  exports: {
    playerState: (action, player, init) => {
      if (!player._state) player._state = init();
      return player._state;
    },
  },
};

const navPath = require.resolve("../../../bots/behaviours/navigation/BotNavigation");
require.cache[navPath] = {
  exports: {
    requestMovement: () => {},
    clearMovementRequest: () => {},
  },
};

const sitesPath = require.resolve("../CitizenSites");
require.cache[sitesPath] = {
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "varrock",
  },
};

const constantsPath = require.resolve("../../constants");
require.cache[constantsPath] = {
  exports: { ATTR_CITIZEN_PERSONALITY: "citizen:personality" },
};

const humanizerPath = require.resolve("../../lib/humanizer");
require.cache[humanizerPath] = {
  exports: {
    agentRng: () => Math.random,
    personalSpot: () => ({ x: 3200, y: 3200 }),
    humanizerProfile: () => ({}),
  },
};

// Mock the surgery API.
const surgeryPath = require.resolve("../../lib/CitizenSurgery");
require.cache[surgeryPath] = {
  exports: {
    isSurgeon: (name) => name.toLowerCase() === "mira",
    procedureOf: () => null,
  },
};

const { createCitizenSurgeonAction } = require("./CitizenSurgeon");

function fakePlayer(username) {
  return {
    username,
    getUsername: () => username,
    getX: () => 3200,
    getY: () => 3200,
    getAttribute: () => ({}),
    getInventory: () => ({ count: () => 0, remove: () => {} }),
    getSkills: () => ({ addXp: () => {} }),
  };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("CitizenSurgeon brain action tests:");

test("factory creates an action with the right id", () => {
  const action = createCitizenSurgeonAction({}, {});
  assert.strictEqual(action.id, "citizenSurgeon");
  assert.strictEqual(typeof action.update, "function");
});

test("non-surgeon ends honestly with success", () => {
  const action = createCitizenSurgeonAction({}, {});
  const player = fakePlayer("Tom"); // not a surgeon
  const result = action.update({ player, nowMs: Date.now() });
  assert.strictEqual(result, "success");
});

test("surgeon walks to hospital (outbound phase)", () => {
  const action = createCitizenSurgeonAction({}, {});
  const player = fakePlayer("Mira"); // is a surgeon per mock
  // Player starts at the hospital tile already (3200,3200) — should
  // transition to working.
  const r1 = action.update({ player, nowMs: 1000 });
  assert.strictEqual(r1, "running");
  assert.strictEqual(player._state.phase, "working");
});

test("surgeon gives up after timeout", () => {
  const action = createCitizenSurgeonAction({}, {});
  const player = fakePlayer("Mira");
  action.update({ player, nowMs: 1000 });
  // Jump past the give-up time (10 min).
  const result = action.update({ player, nowMs: 1000 + 11 * 60 * 1000 });
  assert.strictEqual(result, "success");
});

test("action never throws on minimal player", () => {
  const action = createCitizenSurgeonAction({}, {});
  const result = action.update({ player: {}, nowMs: Date.now() });
  assert.ok(["success", "running"].includes(result));
});

console.log(`\n${passed} tests passed.`);
