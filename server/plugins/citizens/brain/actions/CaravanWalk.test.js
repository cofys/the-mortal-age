"use strict";

/**
 * CaravanWalk.test.js — brain action unit checks.
 *
 * Proves the caravan walk action's contracts without a running server:
 *   - Factory returns an action with id "caravanWalk".
 *   - No caravan:duty attribute: "failed" (brain re-decides).
 *   - Duty set but caravan gone/invisible: "failed".
 *   - Duty set and caravan visible: requests movement toward the caravan's
 *     current target waypoint with reason "caravan_walk" ("running").
 *   - Already at the waypoint: holds ("running"), no movement spam.
 *   - stop() clears the movement request.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenTravel.test.js) so plain-node tests stay engine-free.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- stubs ------------------------------------------------------------------

const movementCalls = [];
let cleared = 0;

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": {
      playerState: (action, player, init) => {
        if (!player.__caravanState) player.__caravanState = init();
        return player.__caravanState;
      },
    },
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y, opts) => {
        movementCalls.push({ player, x, y, opts });
        return true;
      },
      clearMovementRequest: () => {
        cleared += 1;
      },
    },
    "../../constants": require("../../constants"),
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const full = path.join(__dirname, rel);
    const resolved = require.resolve(full);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }
}
stubEngineModules();

// Stub the caravan store with an in-memory lookup.
const caravans = new Map();
{
  const full = path.join(__dirname, "../../lib/CitizenTradeCaravans");
  const resolved = require.resolve(full);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      getCaravanById: (id) => caravans.get(id) ?? null,
    },
  };
}

const { createCaravanWalkAction } = require("./CaravanWalk");

// --- fakes ------------------------------------------------------------------

function fakePlayer({ duty = null, x = 0, y = 0, z = 0 } = {}) {
  return {
    __duty: duty,
    getAttribute(k) {
      return k === "caravan:duty" ? this.__duty : null;
    },
    getLocation() {
      return {
        getX: () => x,
        getY: () => y,
        getZ: () => z,
      };
    },
    getForceMovement: () => null,
    getMovementQueue: () => ({ size: () => 0 }),
  };
}

// --- tests ------------------------------------------------------------------

const action = createCaravanWalkAction({}, {});
assert.equal(action.id, "caravanWalk");

// No duty attribute: failed.
{
  const player = fakePlayer({ duty: null });
  assert.equal(action.update({ player, nowMs: 1 }), "failed");
  assert.equal(movementCalls.length, 0);
}

// Duty set, caravan unknown: failed.
{
  const player = fakePlayer({ duty: "caravan:ghost:1" });
  assert.equal(action.update({ player, nowMs: 2 }), "failed");
}

// Duty set, caravan invisible (abstracted leg): failed.
{
  caravans.set("caravan:quiet:1", {
    id: "caravan:quiet:1",
    visible: false,
    walkPath: [{ x: 100, y: 100, z: 0 }],
    waypointIndex: 0,
  });
  const player = fakePlayer({ duty: "caravan:quiet:1" });
  assert.equal(action.update({ player, nowMs: 3 }), "failed");
}

// Duty set, caravan visible: walks toward the current target waypoint.
{
  caravans.set("caravan:loud:1", {
    id: "caravan:loud:1",
    visible: true,
    walkPath: [
      { x: 100, y: 100, z: 0 },
      { x: 200, y: 100, z: 0 },
    ],
    waypointIndex: 1,
  });
  const player = fakePlayer({ duty: "caravan:loud:1", x: 150, y: 100, z: 0 });
  assert.equal(action.update({ player, nowMs: 4 }), "running");
  assert.equal(movementCalls.length, 1);
  assert.equal(movementCalls[0].x, 200);
  assert.equal(movementCalls[0].y, 100);
  assert.equal(movementCalls[0].opts.reason, "caravan_walk");
}

// Already at the waypoint: holds, no movement request.
{
  movementCalls.length = 0;
  const player = fakePlayer({ duty: "caravan:loud:1", x: 200, y: 101, z: 0 });
  assert.equal(action.update({ player, nowMs: 5 }), "running");
  assert.equal(movementCalls.length, 0, "no movement spam while holding");
}

// stop() clears the movement request.
{
  const player = fakePlayer({ duty: "caravan:loud:1" });
  action.stop({ player });
  assert.equal(cleared, 1);
}

console.log("CaravanWalk.test.js: all assertions passed");
