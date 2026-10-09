"use strict";

/**
 * CitizenInsurerWork.test.js — brain action tests for real insurance work.
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

const stubInsurance = {
  _insurers: {},
  insurerFor(u) { return this._insurers[String(u ?? "").toLowerCase()] ?? null; },
  officeTile(kid) {
    const tiles = { misthalin: { x: 3259, y: 3421 }, asgarnia: { x: 2953, y: 3368 } };
    return tiles[String(kid ?? "").toLowerCase()] ?? null;
  },
  reset() { this._insurers = {}; },
  register(u, kid) { this._insurers[String(u).toLowerCase()] = { kingdomId: kid }; },
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
  // Real ActionState shape: playerState(action, player, create).
  playerState(action, player, create) {
    const key = `${player.username}:${action?.id ?? "action"}`;
    if (!_actionStates.has(key)) _actionStates.set(key, create());
    return _actionStates.get(key);
  },
  reset() { _actionStates.clear(); },
};

Module.prototype.require = function (id) {
  if (id === "../../lib/CitizenInsurance") return stubInsurance;
  if (id === "../CitizenSites") return stubSites;
  if (id === "../../../bots/behaviours/navigation/BotNavigation") return stubNav;
  if (id === "../../../bots/brain/ActionState") return stubActionState;
  return origRequire.apply(this, arguments);
};

const { createCitizenInsurerWorkAction } = require("./CitizenInsurerWork");

function mockPlayer(username, x, y) {
  return {
    username,
    getUsername: () => username,
    getPosition: () => ({ x, y, z: 0 }),
  };
}

test("factory creates action with id", () => {
  stubInsurance.reset(); stubActionState.reset();
  const action = createCitizenInsurerWorkAction();
  assert.strictEqual(action.id, "citizenInsurerWork");
  assert(typeof action.canStart === "function");
  assert(typeof action.tick === "function");
});

test("canStart requires insurance module and office tile", () => {
  stubInsurance.reset(); stubActionState.reset();
  const action = createCitizenInsurerWorkAction();
  const p = mockPlayer("Alice", 3200, 3200);
  assert.strictEqual(action.canStart(p), true);
});

test("non-insurer goes home honestly", () => {
  stubInsurance.reset(); stubActionState.reset();
  const action = createCitizenInsurerWorkAction();
  const p = mockPlayer("Bob", 3200, 3200); // at home already
  const result = action.tick(p, {});
  assert.strictEqual(result, "success", "non-insurer at home succeeds");
});

test("non-insurer walks home when away", () => {
  stubInsurance.reset(); stubActionState.reset();
  const action = createCitizenInsurerWorkAction();
  const p = mockPlayer("Carol", 3300, 3300); // away from home
  const result = action.tick(p, {});
  assert.strictEqual(result, "running", "non-insurer walks home");
});

test("insurer walks to office", () => {
  stubInsurance.reset(); stubActionState.reset();
  stubInsurance.register("Dave", "misthalin");
  const action = createCitizenInsurerWorkAction();
  const p = mockPlayer("Dave", 3200, 3200); // away from office
  const result = action.tick(p, {});
  assert.strictEqual(result, "running", "insurer walks to office");
});

test("insurer at office serves", () => {
  stubInsurance.reset(); stubActionState.reset();
  stubInsurance.register("Eve", "misthalin");
  const action = createCitizenInsurerWorkAction();
  const p = mockPlayer("Eve", 3259, 3421); // at office
  let result = action.tick(p, {});
  assert.strictEqual(result, "running", "first tick transitions to serving");
  result = action.tick(p, {});
  assert.strictEqual(result, "running", "serving continues");
});

test("give-up returns success", () => {
  stubInsurance.reset(); stubActionState.reset();
  stubInsurance.register("Frank", "misthalin");
  const action = createCitizenInsurerWorkAction();
  const p = mockPlayer("Frank", 3200, 3200);
  // Force the start time to be old
  const st = stubActionState.playerState(action, p, () => ({}));
  st.startedAt = Date.now() - 11 * 60 * 1000;
  const result = action.tick(p, {});
  assert.strictEqual(result, "success", "give-up is honest success");
});

test("null player safety", () => {
  stubInsurance.reset(); stubActionState.reset();
  const action = createCitizenInsurerWorkAction();
  // Should not throw on minimal player
  const result = action.tick({ username: "Ghost" }, {});
  assert(["running", "success"].includes(result), "handles minimal player");
});

console.log(`\nCitizenInsurerWork: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
