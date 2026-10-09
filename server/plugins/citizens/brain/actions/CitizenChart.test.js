"use strict";

/**
 * CitizenChart.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenObserve.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenChart.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__chartState) player.__chartState = init();
      return player.__chartState;
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
    siteTileByKingdom: () => ({ x: 3240, y: 3160, z: 0 }),
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
    agentRng: () => () => 0.5, // pickType -> city (no discovery needed)
    humanizerProfile: () => ({}),
  },
};

// --- real modules under test ---

const Maps = require("../../lib/CitizenMaps");
const { createCitizenChartAction } = require("./CitizenChart");

// --- helpers ---

const SHOP_TILE = { x: 3175, y: 3212, z: 0 }; // siteTile(3200,3200) offset -25/+12
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, opts) {
  const o = opts || {};
  let papyrus = o.papyrus ?? 0;
  return {
    __chartState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => o.position || { x: 0, y: 0, z: 0 },
    position: o.position || { x: 0, y: 0, z: 0 },
    inventory: {
      count: (id) => (id === 970 ? papyrus : 0),
      remove: (id, n) => { if (id === 970 && papyrus >= n) { papyrus -= n; return true; } return false; },
    },
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Maps.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenChart tests:");

test("factory returns action with id citizenChart", () => {
  const action = createCitizenChartAction({}, {});
  assert.strictEqual(action.id, "citizenChart");
  assert.strictEqual(typeof action.update, "function");
});

test("non-curious non-cartographer walks home honestly", () => {
  const action = createCitizenChartAction({}, {});
  const player = stubPlayer("Bored Bob", { personality: { curiosity: 0.1 } });
  const res = action.update({ player, nowMs: 1000 });
  assert.strictEqual(res, "running");
  assert.ok(player.__movedTo, "expected a walk-home movement request");
});

test("curious citizen far from shop walks to the shop", () => {
  const action = createCitizenChartAction({}, {});
  const player = stubPlayer("Curious Cat", {
    personality: { curiosity: 0.9 },
    position: { x: 0, y: 0, z: 0 },
  });
  const res = action.update({ player, nowMs: 1000 });
  assert.strictEqual(res, "running");
  assert.ok(player.__movedTo, "expected a walk-to-shop movement request");
  assert.strictEqual(Maps.isCartographer("Curious Cat"), true); // registered on arrival logic
});

test("cartographer at shop with papyrus drafts a real map", () => {
  Maps.registerCartographer("Drafty", "varrock");
  const action = createCitizenChartAction({}, {});
  const player = stubPlayer("Drafty", {
    personality: { curiosity: 0.9 },
    position: { ...SHOP_TILE },
    papyrus: 3,
  });
  assert.strictEqual(action.update({ player, nowMs: 1000 }), "running"); // outbound -> drafting
  assert.strictEqual(action.update({ player, nowMs: 2000 }), "running"); // draft round
  const desc = Maps.describe("varrock");
  assert.strictEqual(desc.mapCount, 1, "expected one drafted map");
  assert.strictEqual(desc.listingCount, 1, "drafted map should be listed for sale");
});

test("cartographer with no papyrus honestly ends the session", () => {
  Maps.registerCartographer("Broke", "varrock");
  const action = createCitizenChartAction({}, {});
  const player = stubPlayer("Broke", {
    personality: { curiosity: 0.9 },
    position: { ...SHOP_TILE },
    papyrus: 0,
  });
  const res = action.update({ player, nowMs: 1000 });
  assert.strictEqual(res, "running"); // heading home, no map invented
  assert.strictEqual(Maps.describe("varrock").mapCount, 0);
});

test("give-up timeout sends the citizen home", () => {
  Maps.registerCartographer("Slow", "varrock");
  const action = createCitizenChartAction({}, {});
  const player = stubPlayer("Slow", {
    personality: { curiosity: 0.9 },
    position: { ...SHOP_TILE },
    papyrus: 3,
  });
  action.update({ player, nowMs: 1000 }); // init + first draft round
  const res = action.update({ player, nowMs: 1000 + 11 * 60 * 1000 }); // past give-up
  assert.strictEqual(res, "running");
  assert.strictEqual(player.__chartState.phase, "returning");
});

test("null player is an honest success", () => {
  const action = createCitizenChartAction({}, {});
  assert.strictEqual(action.update({ player: null, nowMs: 1000 }), "success");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
