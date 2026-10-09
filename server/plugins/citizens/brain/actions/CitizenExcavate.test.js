"use strict";

/**
 * CitizenExcavate.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenChart.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenExcavate.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__excavateState) player.__excavateState = init();
      return player.__excavateState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: (player, tile) => { player.__movedTo = tile; },
    clearMovementRequest: () => {},
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "varrock",
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

const Arch = require("../../lib/CitizenArchaeology");
const { createCitizenExcavateAction } = require("./CitizenExcavate");

// --- helpers ---

function stubPlayer(username, opts) {
  const o = opts || {};
  return {
    __excavateState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => o.position || { x: 0, y: 0, z: 0 },
    position: o.position || { x: 0, y: 0, z: 0 },
  };
}

function runTicks(action, player, ticks, stepMs) {
  let now = 1_000_000;
  let last = "running";
  for (let i = 0; i < ticks; i++) {
    now += stepMs;
    last = action.update({ player, nowMs: now, world: {} });
    if (last !== "running") break;
  }
  return last;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Arch.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenExcavate tests:");

test("factory returns action with id citizenExcavate", () => {
  const action = createCitizenExcavateAction({}, {});
  assert.strictEqual(action.id, "citizenExcavate");
  assert.strictEqual(typeof action.update, "function");
});

test("non-archaeologist without curiosity walks home", () => {
  // Start at the stub home tile so the honest walk-home completes.
  const p = stubPlayer("Bored", { personality: { curiosity: 0.1 }, position: { x: 3200, y: 3200, z: 0 } });
  const action = createCitizenExcavateAction({}, {});
  const res = runTicks(action, p, 5, 1000);
  assert.strictEqual(res, "success", "should finish by walking home");
  assert.strictEqual(Arch.isArchaeologist("Bored"), false, "not registered");
});

test("curious citizen registers and digs real artifacts", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a lost tomb" }, "varrock", "Bob").site;
  assert.ok(site.tile, "site has a tile");
  // Start AT the site tile so digging starts immediately.
  const p = stubPlayer("Curious", {
    personality: { curiosity: 0.9 },
    position: { x: site.tile.x, y: site.tile.y, z: site.tile.z || 0 },
  });
  const action = createCitizenExcavateAction({}, {});
  runTicks(action, p, 40, 9000); // 9s steps > dig cooldown
  assert.strictEqual(Arch.isArchaeologist("Curious"), true, "registered on arrival");
  assert.ok(Arch.describe().artifacts >= 1, "dug at least one real artifact");
});

test("no open dig site means honest walk home, nothing invented", () => {
  Arch.registerArchaeologist("Keen", "varrock"); // archaeologist, but no sites
  const p = stubPlayer("Keen", { personality: { curiosity: 0.9 }, position: { x: 3200, y: 3200, z: 0 } });
  const action = createCitizenExcavateAction({}, {});
  const res = runTicks(action, p, 5, 1000);
  assert.strictEqual(res, "success");
  assert.strictEqual(Arch.describe().artifacts, 0, "nothing dug, nothing invented");
});

test("exhausted site mid-session ends honestly", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  // Exhaust it directly, then run the action: it should see no active sites.
  for (let i = 0; i < site.totalSlots; i++) Arch.excavate("someone", site.id);
  assert.strictEqual(Arch.activeSites("varrock").length, 0);
  const p = stubPlayer("Late", { personality: { curiosity: 0.9 }, position: { x: 3200, y: 3200, z: 0 } });
  const action = createCitizenExcavateAction({}, {});
  const res = runTicks(action, p, 5, 1000);
  assert.strictEqual(res, "success");
});

test("action survives null player", () => {
  const action = createCitizenExcavateAction({}, {});
  assert.strictEqual(action.update({ player: null, nowMs: 1, world: {} }), "success");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
