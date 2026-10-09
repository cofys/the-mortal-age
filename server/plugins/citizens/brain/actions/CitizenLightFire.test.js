"use strict";

/**
 * CitizenLightFire unit checks — burn logs for real Firemaking XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenLightFire".
 *   - No Firemaking plugin -> "failed" (fail fast, don't stall).
 *   - Fire already burning (isFiremakingActive) -> "running".
 *   - No burnable logs -> "success" (done, brain re-decides).
 *   - Has logs, tile clear -> startBotInventoryFiremaking called, "running".
 *   - Tile blocked (start returns false) -> steps aside via requestMovement.
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _findBurnableLog: picks burnable logs, skips junk, null when empty.
 *   - Decision scoring: citizen_light_fire scores low with no logs, decent
 *     with logs, penalized when hurt/exhausted, bonus in the evening.
 *
 * The Firemaking plugin and bot navigation are stubbed in the require cache
 * (same pattern as CitizenRoutine.test.js) so plain-node tests stay
 * engine-free.
 */
const assert = require("node:assert/strict");

// --- stubs -----------------------------------------------------------------
const movementCalls = [];
const firemakingCalls = [];

let mockFiremaking = null;

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y, opts) => {
        movementCalls.push({ player, x, y, opts });
        return true;
      },
      clearMovementRequest: () => {},
    },
    "../../../skills/Firemaking.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockFiremaking && prop in mockFiremaking) {
            return mockFiremaking[prop];
          }
          return undefined;
        },
      }
    ),
    "../../lib/humanizer": {
      agentRng: () => Math.random,
      personalSpot: (username, x, y) => ({ x: x + 2, y: y + 2 }),
      humanizerProfile: () => ({}),
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const path = require.resolve(rel);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
}
stubEngineModules();

const {
  createCitizenLightFireAction,
  _findBurnableLog: findBurnableLog,
} = require("./CitizenLightFire");
const { scoreActivity } = require("../CitizenDecisions");

// --- mock players -----------------------------------------------------------
const LOGS_ID = 1511; // normal logs
const OAK_LOGS_ID = 1521;
const COINS_ID = 995;

function mockItem(id) {
  return { getId: () => id };
}

function mockPlayer({ items = [], burning = false, moving = false } = {}) {
  return {
    getUsername: () => "Test Citizen",
    getAttribute: () => ({}),
    getInventory: () => ({
      getItems: () => items.map(mockItem),
    }),
    getLocation: () => ({
      getX: () => 3200,
      getY: () => 3200,
      getZ: () => 0,
    }),
    getForceMovement: () => (moving ? {} : null),
    getMovementQueue: () => ({ size: () => (moving ? 3 : 0) }),
    __burning: burning,
  };
}

function mockFiremakingPlugin({
  burning = false,
  startResult = true,
  burnableIds = [LOGS_ID, OAK_LOGS_ID],
} = {}) {
  return {
    isFiremakingActive: (player) => player.__burning || burning,
    isWoodcuttingLog: (id) => burnableIds.includes(id),
    canPlayerBurnLog: () => true,
    startBotInventoryFiremaking: (player, logId) => {
      firemakingCalls.push({ player, logId });
      return startResult;
    },
  };
}

function freshCtx(player, nowMs = 1000000) {
  return { player, nowMs, world: { log: () => {} } };
}

function reset() {
  movementCalls.length = 0;
  firemakingCalls.length = 0;
  mockFiremaking = null;
}

// --- tests -------------------------------------------------------------------

{
  // 1. Factory returns a well-formed action.
  reset();
  mockFiremaking = mockFiremakingPlugin();
  const action = createCitizenLightFireAction({}, {});
  assert.equal(action.id, "citizenLightFire", "action id");
  assert.equal(typeof action.update, "function", "has update");
  assert.equal(typeof action.stop, "function", "has stop");
  console.log("ok 1 - factory returns well-formed action");
}

{
  // 2. No Firemaking plugin -> "failed".
  reset();
  const path = require.resolve("../../../skills/Firemaking.plugin");
  require.cache[path].exports = {};
  const action = createCitizenLightFireAction({}, {});
  const result = action.update(freshCtx(mockPlayer({ items: [LOGS_ID] })));
  assert.equal(result, "failed", "fails fast without the plugin");
  stubEngineModules();
  console.log("ok 2 - fails fast when Firemaking plugin is missing");
}

{
  // 3. Fire already burning -> "running".
  reset();
  mockFiremaking = mockFiremakingPlugin();
  const action = createCitizenLightFireAction({}, {});
  const result = action.update(freshCtx(mockPlayer({ items: [LOGS_ID], burning: true })));
  assert.equal(result, "running", "waits out the active fire");
  assert.deepEqual(firemakingCalls, [], "does not start a second fire");
  console.log("ok 3 - running while a fire burns");
}

{
  // 4. No burnable logs -> "success".
  reset();
  mockFiremaking = mockFiremakingPlugin();
  const action = createCitizenLightFireAction({}, {});
  const player = mockPlayer({ items: [COINS_ID] });
  const result = action.update(freshCtx(player));
  assert.equal(result, "success", "done when no logs to burn");
  console.log("ok 4 - success with no burnable logs");
}

{
  // 5. Has logs, tile clear -> starts the fire, "running".
  reset();
  mockFiremaking = mockFiremakingPlugin({ startResult: true });
  const action = createCitizenLightFireAction({}, {});
  const player = mockPlayer({ items: [LOGS_ID] });
  const result = action.update(freshCtx(player));
  assert.equal(result, "running", "fire started");
  assert.equal(firemakingCalls.length, 1, "startBotInventoryFiremaking called once");
  assert.equal(firemakingCalls[0].logId, LOGS_ID, "passes the log id");
  console.log("ok 5 - lights the fire via the real plugin entry point");
}

{
  // 6. Tile blocked (start returns false) -> steps aside, "running".
  reset();
  mockFiremaking = mockFiremakingPlugin({ startResult: false });
  const action = createCitizenLightFireAction({}, {});
  const player = mockPlayer({ items: [LOGS_ID] });
  const result = action.update(freshCtx(player));
  assert.equal(result, "running", "still running after stepping aside");
  assert.equal(movementCalls.length, 1, "requests movement to a clear spot");
  assert.equal(movementCalls[0].opts.reason, "citizen_light_fire", "movement reason");
  console.log("ok 6 - steps aside when the tile is blocked");
}

{
  // 7. Give-up timeout -> "success", never stalls.
  reset();
  mockFiremaking = mockFiremakingPlugin({ startResult: false });
  const action = createCitizenLightFireAction({}, {});
  const player = mockPlayer({ items: [LOGS_ID] });
  action.update(freshCtx(player, 1000000));
  const result = action.update(freshCtx(player, 1000000 + 6 * 60 * 1000));
  assert.equal(result, "success", "gives up instead of stalling the day");
  console.log("ok 7 - give-up timeout ends the action");
}

{
  // 8. _findBurnableLog: picks burnable logs, skips junk.
  reset();
  mockFiremaking = mockFiremakingPlugin();
  const Firemaking = mockFiremaking;
  const withLogs = mockPlayer({ items: [COINS_ID, LOGS_ID] });
  assert.equal(findBurnableLog(Firemaking, withLogs), LOGS_ID, "finds the log among junk");
  const noLogs = mockPlayer({ items: [COINS_ID] });
  assert.equal(findBurnableLog(Firemaking, noLogs), null, "null when no logs");
  const empty = mockPlayer({ items: [] });
  assert.equal(findBurnableLog(Firemaking, empty), null, "null on empty inventory");
  console.log("ok 8 - _findBurnableLog picks burnable logs only");
}

{
  // 9. Decision scoring: no logs -> low score.
  const snap = {
    hp: 100, energy: 100, mood: 80, goal: null, personality: {},
    coins: 100, food: 5, freeSlots: 20, nearby: 0, logs: 0, hour: 12,
  };
  const s = scoreActivity("citizen_light_fire", snap);
  assert.equal(s, 4, "no logs means no fire");
  console.log("ok 9 - scoring: no logs scores 4");
}

{
  // 10. Decision scoring: logs + evening + industrious -> strong score.
  const snap = {
    hp: 100, energy: 100, mood: 80, goal: null,
    personality: { industriousness: 90 },
    coins: 100, food: 5, freeSlots: 20, nearby: 3, logs: 12, hour: 19,
  };
  const s = scoreActivity("citizen_light_fire", snap);
  assert.ok(s > 40, `strong score with logs in the evening, got ${s}`);
  console.log(`ok 10 - scoring: logs in the evening scores ${s}`);
}

{
  // 11. Decision scoring: hurt citizen won't light fires.
  const snap = {
    hp: 20, energy: 100, mood: 80, goal: null, personality: {},
    coins: 100, food: 5, freeSlots: 20, nearby: 0, logs: 10, hour: 19,
  };
  const s = scoreActivity("citizen_light_fire", snap);
  assert.ok(s < 30, `hurt citizen deprioritizes firemaking, got ${s}`);
  console.log(`ok 11 - scoring: hurt citizen scores ${s}`);
}

console.log("all CitizenLightFire tests passed");
