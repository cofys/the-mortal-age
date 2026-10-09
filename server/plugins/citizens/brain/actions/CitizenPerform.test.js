"use strict";

/**
 * CitizenPerform.test.js — brain action tests for musicians/dancers.
 *
 * Plain node:assert. Mocks the action's engine dependencies.
 * Run with: node <this file>.
 */

const assert = require("node:assert");

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
    kingdomIdOf: () => "misthalin",
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
    personalSpot: () => ({ x: 3200, y: 3200, z: 0 }),
    humanizerProfile: () => ({}),
  },
};

// Mock the music/dance API.
const practiceCalls = [];
const mdPath = require.resolve("../../lib/CitizenMusicDance");
require.cache[mdPath] = {
  exports: {
    musicOf: (name) => (name.toLowerCase() === "lyra" ? 70 : name.toLowerCase() === "twyla" ? 10 : 0),
    danceOf: (name) => (name.toLowerCase() === "twyla" ? 75 : 0),
    practice: (username, player, kind, nowMs) => {
      practiceCalls.push({ username, kind });
      return { ok: true, gain: 1 };
    },
    hallTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const { createCitizenPerformAction } = require("./CitizenPerform");

function fakePlayer(username) {
  return {
    username,
    getUsername: () => username,
    getPosition: () => ({ x: 3200, y: 3200, z: 0 }),
    getAttribute: () => ({}),
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

console.log("CitizenPerform brain action tests:");

test("factory creates an action with the right id", () => {
  const action = createCitizenPerformAction({}, {});
  assert.strictEqual(action.id, "citizenPerform");
  assert.strictEqual(typeof action.update, "function");
});

test("non-performer ends honestly with success", () => {
  const action = createCitizenPerformAction({}, {});
  const player = fakePlayer("Tom"); // no skill
  const result = action.update({ player, nowMs: Date.now() });
  assert.strictEqual(result, "success");
});

test("musician walks to the dance hall (outbound phase)", () => {
  const action = createCitizenPerformAction({}, {});
  const player = fakePlayer("Lyra"); // musician per mock
  // Player starts at the hall tile already (3200,3200) — should
  // transition to performing.
  const r1 = action.update({ player, nowMs: 1000 });
  assert.strictEqual(r1, "running");
  assert.strictEqual(player._state.phase, "performing");
});

test("dancer practices dance (not music)", () => {
  practiceCalls.length = 0;
  const action = createCitizenPerformAction({}, {});
  const player = fakePlayer("Twyla"); // dancer per mock
  action.update({ player, nowMs: 1000 }); // outbound -> performing
  action.update({ player, nowMs: 20000 }); // performing (past 15s cooldown)
  assert.ok(practiceCalls.length >= 1, "practiced");
  assert.ok(practiceCalls.every((c) => c.kind === "dance"), "dancer practices dance");
});

test("musician practices music", () => {
  practiceCalls.length = 0;
  const action = createCitizenPerformAction({}, {});
  const player = fakePlayer("Lyra");
  action.update({ player, nowMs: 1000 });
  action.update({ player, nowMs: 20000 });
  assert.ok(practiceCalls.length >= 1, "practiced");
  assert.ok(practiceCalls.every((c) => c.kind === "music"), "musician practices music");
});

test("action gives up and returns home", () => {
  const action = createCitizenPerformAction({}, {});
  const player = fakePlayer("Lyra");
  action.update({ player, nowMs: 1000 });
  const r = action.update({ player, nowMs: 1000 + 11 * 60 * 1000 }); // past give-up
  assert.strictEqual(r, "success");
  assert.strictEqual(player._state.phase, "returning");
});

console.log(`\n${passed} CitizenPerform tests passed.`);
