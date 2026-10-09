"use strict";

/**
 * CitizenCurate.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenChart.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenCurate.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__curateState) player.__curateState = init();
      return player.__curateState;
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
    siteTile: (player, name) => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "misthalin",
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

// Stub the galleries data tier: curators set + gallery tile.
const galleriesPath = path.resolve(__dirname, "../../lib/CitizenGalleries.js");
const curatorSet = new Set();
require.cache[galleriesPath] = {
  id: galleriesPath, filename: galleriesPath, loaded: true,
  exports: {
    isCurator: (u) => curatorSet.has(String(u).toLowerCase()),
    galleryTile: () => ({ x: 3210, y: 3210, z: 0 }),
  },
};

const { createCitizenCurateAction } = require("./CitizenCurate.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    curatorSet.clear();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

function mockPlayer(username, x, y) {
  return {
    username,
    __x: x ?? 0, __y: y ?? 0,
    getUsername() { return username; },
    getAttribute() { return {}; },
    getPosition() { return { x: this.__x, y: this.__y, z: 0 }; },
    __movedTo: null,
  };
}

test("factory creates the action", () => {
  const action = createCitizenCurateAction({}, {});
  assert.strictEqual(action.id, "citizenCurate");
  assert.strictEqual(typeof action.update, "function");
});

test("non-curator walks home honestly", () => {
  const action = createCitizenCurateAction({}, {});
  const player = mockPlayer("NotACurator", 0, 0);
  const now = 1000000;
  let status = action.update({ player, nowMs: now });
  assert.strictEqual(status, "running");
  // Should be heading home (market tile stub at 3200,3200).
  assert.ok(player.__movedTo, "should walk somewhere");
  assert.strictEqual(player.__movedTo.x, 3200);
});

test("curator walks to the gallery tile", () => {
  curatorSet.add("curatorbob");
  const action = createCitizenCurateAction({}, {});
  const player = mockPlayer("CuratorBob", 0, 0);
  const now = 1000000;
  action.update({ player, nowMs: now });
  assert.ok(player.__movedTo, "should walk to gallery");
  assert.strictEqual(player.__movedTo.x, 3210);
  assert.strictEqual(player.__movedTo.y, 3210);
});

test("curator curates in rounds then returns home", () => {
  curatorSet.add("curatorbob");
  const action = createCitizenCurateAction({}, {});
  // Start AT the gallery tile.
  const player = mockPlayer("CuratorBob", 3210, 3210);
  let now = 1000000;
  action.update({ player, nowMs: now }); // outbound -> curating
  const state = player.__curateState;
  assert.strictEqual(state.phase, "curating");

  // Run rounds (8s apart, 3 rounds).
  for (let i = 0; i < 3; i++) {
    now += 9000;
    action.update({ player, nowMs: now });
  }
  assert.strictEqual(state.roundsDone, 3);
  // Next tick moves to returning.
  now += 9000;
  action.update({ player, nowMs: now });
  assert.strictEqual(state.phase, "returning");
});

test("null player is safe", () => {
  const action = createCitizenCurateAction({}, {});
  assert.strictEqual(action.update({ player: null, nowMs: 1 }), "success");
});

test("give-up timeout sends the curator home", () => {
  curatorSet.add("curatorbob");
  const action = createCitizenCurateAction({}, {});
  const player = mockPlayer("CuratorBob", 0, 0);
  action.update({ player, nowMs: 1000000 });
  const state = player.__curateState;
  assert.strictEqual(state.phase, "outbound");
  // Jump past the 10-minute give-up.
  const status = action.update({ player, nowMs: 1000000 + 11 * 60 * 1000 });
  assert.strictEqual(status, "running");
  assert.strictEqual(state.phase, "returning");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
