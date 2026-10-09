"use strict";

/**
 * CitizenBankerWork.test.js — brain action tests for real banking work.
 * Plain node, no jest. Uses require-cache stubs for engine-free testing.
 */

const assert = require("assert");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack?.split("\n")[1] ?? ""}`);
  }
}

// --- Stub the engine modules before requiring the action ---
const Module = require("module");
const origRequire = Module.prototype.require;

const stubBanking = {
  _bankers: {},
  bankerFor(u) { return this._bankers[String(u ?? "").toLowerCase()] ?? null; },
  branchTile(kid) {
    const tiles = { misthalin: { x: 3253, y: 3421 }, asgarnia: { x: 2947, y: 3368 } };
    return tiles[String(kid ?? "").toLowerCase()] ?? null;
  },
  reset() { this._bankers = {}; },
  register(u, kid) { this._bankers[String(u).toLowerCase()] = { kingdomId: kid }; },
};

const stubSites = {
  kingdomIdOf: () => "misthalin",
  siteTile: (player, kind) => kind === "home" ? { x: 3200, y: 3200 } : { x: 3250, y: 3420 },
};

const stubNav = {
  requestMovement: () => {},
  clearMovementRequest: () => {},
};

const _actionStates = new Map();
const stubActionState = {
  playerState(player, id) {
    const key = `${player.username}:${id}`;
    if (!_actionStates.has(key)) _actionStates.set(key, {});
    return _actionStates.get(key);
  },
  reset() { _actionStates.clear(); },
};

Module.prototype.require = function (id) {
  if (id === "../../lib/CitizenBanking") return stubBanking;
  if (id === "../CitizenSites") return stubSites;
  if (id === "../../../bots/behaviours/navigation/BotNavigation") return stubNav;
  if (id === "../../../bots/brain/ActionState") return stubActionState;
  return origRequire.apply(this, arguments);
};

const { createCitizenBankerWorkAction } = require("./CitizenBankerWork");

function mockPlayer(username, x, y) {
  return {
    username,
    getUsername: () => username,
    getPosition: () => ({ x, y, z: 0 }),
  };
}

test("factory creates action with id", () => {
  stubBanking.reset(); stubActionState.reset();
  const action = createCitizenBankerWorkAction();
  assert.strictEqual(action.id, "citizenBankerWork");
  assert(typeof action.canStart === "function");
  assert(typeof action.tick === "function");
});

test("canStart requires banking module and branch tile", () => {
  stubBanking.reset(); stubActionState.reset();
  const action = createCitizenBankerWorkAction();
  const p = mockPlayer("Alice", 3200, 3200);
  assert.strictEqual(action.canStart(p), true);
});

test("non-banker goes home honestly", () => {
  stubBanking.reset(); stubActionState.reset();
  const action = createCitizenBankerWorkAction();
  const p = mockPlayer("Bob", 3200, 3200); // at home already
  const result = action.tick(p, {});
  assert.strictEqual(result, "success", "non-banker at home succeeds");
});

test("non-banker walks home when away", () => {
  stubBanking.reset(); stubActionState.reset();
  const action = createCitizenBankerWorkAction();
  const p = mockPlayer("Carol", 3300, 3300); // away from home
  const result = action.tick(p, {});
  assert.strictEqual(result, "running", "non-banker walks home");
});

test("banker walks to branch", () => {
  stubBanking.reset(); stubActionState.reset();
  stubBanking.register("Dave", "misthalin");
  const action = createCitizenBankerWorkAction();
  const p = mockPlayer("Dave", 3200, 3200); // away from branch
  const result = action.tick(p, {});
  assert.strictEqual(result, "running", "banker walks to branch");
});

test("banker at branch serves", () => {
  stubBanking.reset(); stubActionState.reset();
  stubBanking.register("Eve", "misthalin");
  const action = createCitizenBankerWorkAction();
  const p = mockPlayer("Eve", 3253, 3421); // at branch
  let result = action.tick(p, {});
  assert.strictEqual(result, "running", "first tick transitions to serving");
  result = action.tick(p, {});
  assert.strictEqual(result, "running", "serving continues");
});

test("give-up returns success", () => {
  stubBanking.reset(); stubActionState.reset();
  stubBanking.register("Frank", "misthalin");
  const action = createCitizenBankerWorkAction();
  const p = mockPlayer("Frank", 3200, 3200);
  // Force the start time to be old
  const st = stubActionState.playerState(p, "citizenBankerWork");
  st.startedAt = Date.now() - 11 * 60 * 1000;
  const result = action.tick(p, {});
  assert.strictEqual(result, "success", "give-up is honest success");
});

test("null player safety", () => {
  stubBanking.reset(); stubActionState.reset();
  const action = createCitizenBankerWorkAction();
  // Should not throw on minimal player
  const result = action.tick({ username: "Ghost" }, {});
  assert(["running", "success"].includes(result), "handles minimal player");
});

console.log(`\nCitizenBankerWork: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
