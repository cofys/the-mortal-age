"use strict";

/**
 * CitizenReport.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenChart.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenReport.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__reportState) player.__reportState = init();
      return player.__reportState;
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
    siteTileByKingdom: () => ({ x: 3212, y: 3188, z: 0 }), // press tile = market + (12,-12)
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

const Press = require("../../lib/CitizenPress");
const { createCitizenReportAction } = require("./CitizenReport");

// --- helpers ---

const PRESS_TILE = { x: 3224, y: 3176, z: 0 }; // siteTileByKingdom(3212,3188) offset +12/-12
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, opts) {
  const o = opts || {};
  let papyrus = o.papyrus ?? 0;
  return {
    __reportState: null,
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
    __papyrus: () => papyrus,
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Press.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenReport tests:");

test("factory returns action with id citizenReport", () => {
  const action = createCitizenReportAction({}, {});
  assert.strictEqual(action.id, "citizenReport");
  assert.strictEqual(typeof action.update, "function");
});

test("uninterested non-journalist walks home honestly", () => {
  const action = createCitizenReportAction({}, {});
  const player = stubPlayer("Bored Bob", { personality: { curiosity: 0.1 } });
  const res = action.update({ player, nowMs: 1000 });
  assert.strictEqual(res, "running");
  assert.ok(player.__movedTo, "expected a walk-home movement request");
  assert.strictEqual(Press.isJournalist("Bored Bob"), false);
});

test("curious citizen far from press walks to the press", () => {
  const action = createCitizenReportAction({}, {});
  const player = stubPlayer("Curious Cat", {
    personality: { curiosity: 0.9 },
    position: { x: 0, y: 0, z: 0 },
  });
  const res = action.update({ player, nowMs: 1000 });
  assert.strictEqual(res, "running");
  assert.ok(player.__movedTo, "expected a walk-to-press movement request");
  assert.strictEqual(Press.isJournalist("Curious Cat"), true); // registered on first visit
});

test("journalist at press with papyrus files a real story", () => {
  Press.registerJournalist("Nosy", "varrock");
  Press.recordEvent("crime", "varrock", "trial-1", "Bob convicted of theft");
  const action = createCitizenReportAction({}, {});
  const player = stubPlayer("Nosy", {
    personality: { curiosity: 0.9 },
    position: { ...PRESS_TILE },
    papyrus: 3,
  });
  assert.strictEqual(action.update({ player, nowMs: 1000 }), "running"); // outbound -> reporting
  assert.strictEqual(action.update({ player, nowMs: 2000 }), "running"); // report round
  assert.strictEqual(Press.storyCountFor("Nosy"), 1, "expected one filed story");
  assert.strictEqual(player.__papyrus(), 2, "one papyrus consumed");
});

test("journalist with no papyrus honestly ends the session", () => {
  Press.registerJournalist("Broke", "varrock");
  Press.recordEvent("crime", "varrock", "trial-1", "Bob convicted");
  const action = createCitizenReportAction({}, {});
  const player = stubPlayer("Broke", {
    personality: { curiosity: 0.9 },
    position: { ...PRESS_TILE },
    papyrus: 0,
  });
  const res = action.update({ player, nowMs: 1000 });
  assert.strictEqual(res, "running"); // heading home, no story invented
  assert.strictEqual(Press.storyCountFor("Broke"), 0);
});

test("journalist donates spare papyrus to the press on leaving", () => {
  Press.registerJournalist("Generous", "varrock");
  const action = createCitizenReportAction({}, {});
  const player = stubPlayer("Generous", {
    personality: { curiosity: 0.9 },
    position: { ...PRESS_TILE },
    papyrus: 5,
  });
  // Three report rounds (no events to report), then donation + return.
  action.update({ player, nowMs: 1000 });
  action.update({ player, nowMs: 10000 });
  action.update({ player, nowMs: 20000 });
  action.update({ player, nowMs: 30000 }); // 3rd round done
  action.update({ player, nowMs: 40000 }); // rounds done -> donate -> returning
  assert.strictEqual(Press.pressFor("varrock").paper, 3, "expected 5-2 spare donated");
});

test("give-up timeout sends the citizen home", () => {
  Press.registerJournalist("Slow", "varrock");
  const action = createCitizenReportAction({}, {});
  const player = stubPlayer("Slow", {
    personality: { curiosity: 0.9 },
    position: { ...PRESS_TILE },
    papyrus: 3,
  });
  action.update({ player, nowMs: 1000 });
  const res = action.update({ player, nowMs: 1000 + 11 * 60 * 1000 }); // past give-up
  assert.strictEqual(res, "running");
  assert.strictEqual(player.__reportState.phase, "returning");
});

test("null player is an honest success", () => {
  const action = createCitizenReportAction({}, {});
  assert.strictEqual(action.update({ player: null, nowMs: 1000 }), "success");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
