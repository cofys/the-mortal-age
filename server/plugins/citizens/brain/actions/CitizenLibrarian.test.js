"use strict";

/**
 * CitizenLibrarian.test.js — brain action tests (plain node, no jest).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenLibrarian.test.js
 */

const assert = require("assert");
const os = require("os");
const path = require("path");

// --- stubs (MUST be set before requiring the action) ---------------------------
// Stub BotNavigation (pulls TS core modules).
const navPath = require.resolve("../../../bots/behaviours/navigation/BotNavigation");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: () => {},
    clearMovementRequest: () => {},
  },
};

// Stub ActionState.
const statePath = require.resolve("../../../bots/brain/ActionState");
require.cache[statePath] = {
  id: statePath, filename: statePath, loaded: true,
  exports: {
    playerState: () => ({ homeTile: { x: 3200, y: 3200 } }),
  },
};

// Stub CitizenSites.
const sitesPath = require.resolve("../CitizenSites");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    kingdomIdOf: (p) => p?.getAttribute?.("kingdom:id") || null,
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const Lib = require("../../lib/CitizenLibraries");
const { createCitizenLibrarianAction } = require("./CitizenLibrarian");

const SAVE = path.join(os.tmpdir(), `citizen-librarian-action-test-${process.pid}.json`);
Lib._setSavePathForTests(SAVE);
Lib.resetForTests();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// --- stubs -------------------------------------------------------------------
// (Stubs were set up at the top of the file, before requiring the action.)

function fakeCitizen(username, kingdomId, isLibrarian) {
  if (isLibrarian) Lib.registerLibrarian(username, kingdomId, 1000);
  return {
    getUsername: () => username,
    username,
    isBot: true,
    getAttribute: (key) => {
      if (key === "kingdom:id") return kingdomId;
      return null;
    },
    getPosition: () => ({ x: 3200, y: 3200 }),
    getInventory: () => ({
      getItems: () => [{ id: 970, amount: 3 }],
    }),
  };
}

test("factory creates action with tick and reset", () => {
  const action = createCitizenLibrarianAction();
  assert.ok(typeof action.tick === "function");
  assert.ok(typeof action.reset === "function");
});

test("non-librarian walks home honestly", () => {
  Lib.resetForTests();
  const action = createCitizenLibrarianAction();
  const c = fakeCitizen("NotALibrarian", "misthalin", false);
  const res = action.tick(c, 2000);
  assert.ok(res.done);
  assert.strictEqual(res.reason, "walk-home");
});

test("librarian without kingdom walks home", () => {
  Lib.resetForTests();
  const action = createCitizenLibrarianAction();
  const c = fakeCitizen("NoKingdom", null, true);
  // Override to return null kingdom.
  c.getAttribute = () => null;
  const res = action.tick(c, 2000);
  assert.ok(res.done);
});

test("librarian works in rounds", () => {
  Lib.resetForTests();
  const action = createCitizenLibrarianAction();
  const c = fakeCitizen("Worker", "asgarnia", true);
  // First tick: outbound -> working (already at tile).
  const r1 = action.tick(c, 3000);
  assert.ok(!r1.done);
  // Simulate work rounds.
  let res = r1;
  for (let i = 0; i < 10; i++) {
    res = action.tick(c, 3000 + (i + 1) * 9000);
    if (res.done) break;
  }
  assert.ok(res.done); // eventually walks home
});

test("null safety", () => {
  Lib.resetForTests();
  const action = createCitizenLibrarianAction();
  const res = action.tick(null, 4000);
  assert.ok(res.done);
});

test("give-up timeout", () => {
  Lib.resetForTests();
  const action = createCitizenLibrarianAction();
  const c = fakeCitizen("SlowWorker", "kandarin", true);
  // Far away position so it never arrives.
  c.getPosition = () => ({ x: 0, y: 0 });
  // First tick starts the timer.
  action.tick(c, 5000);
  // Jump past give-up.
  const res = action.tick(c, 5000 + 11 * 60 * 1000);
  assert.ok(res.done);
  assert.strictEqual(res.reason, "walk-home");
});

console.log(`\nCitizenLibrarian: ${passed} passed`);
