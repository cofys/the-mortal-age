"use strict";

/**
 * CitizenObserve unit checks — walk to observatory, observe at night, chart.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenObserve".
 *   - Non-astronomers without curiosity → honest "success" (no fake work).
 *   - Daytime → honest "success" (the sky isn't out).
 *   - Give-up timeout returns "success".
 *   - Night observation completes a session and creates a chart.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenEngineerWork.test.js) so plain-node tests stay engine-free.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- stubs ------------------------------------------------------------------

// Stub ActionState.playerState: just run the initializer.
const actionStatePath = path.resolve(
  __dirname, "../../../bots/brain/ActionState.js"
);
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__observeState) player.__observeState = init();
      return player.__observeState;
    },
  },
};

// Stub BotNavigation: track movement requests. Real shape is
// requestMovement(player, targetX, targetY, options) — an object-tile
// second argument silently no-ops (isFinite check fails).
const navPath = path.resolve(
  __dirname, "../../../bots/behaviours/navigation/BotNavigation.js"
);
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: (player, x, y, opts) => {
      player.__movedTo = { x, y, z: opts?.z ?? 0 };
      return true;
    },
    clearMovementRequest: () => {},
  },
};

// Stub CitizenSites.
const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "varrock",
    siteTileByKingdom: () => ({ x: 3240, y: 3160, z: 0 }),
  },
};

// Stub constants.
const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizens:personality" },
};

// Stub humanizer.
const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: () => () => 0.5,
    humanizerProfile: () => ({}),
  },
};

// Stub CitizenDayNight: controllable night/day.
let forceNight = true;
const dayNightPath = path.resolve(__dirname, "../../lib/CitizenDayNight.js");
require.cache[dayNightPath] = {
  id: dayNightPath, filename: dayNightPath, loaded: true,
  exports: { isNight: () => forceNight },
};

// --- real modules under test ------------------------------------------------

const Astro = require("../../lib/CitizenAstronomy");
const { createCitizenObserveAction } = require("./CitizenObserve");

// --- helpers ----------------------------------------------------------------

function stubPlayer(username, opts) {
  const o = opts || {};
  return {
    __observeState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => o.position || { x: 0, y: 0, z: 0 },
    position: o.position || { x: 0, y: 0, z: 0 },
    playEmote: () => {},
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Astro.resetForTests();
    forceNight = true;
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenObserve tests:");

test("factory returns action with id citizenObserve", () => {
  const action = createCitizenObserveAction({}, {});
  assert.strictEqual(action.id, "citizenObserve");
  assert.strictEqual(typeof action.update, "function");
});

test("non-curious non-astronomer gets honest success", () => {
  const action = createCitizenObserveAction({}, {});
  const player = stubPlayer("Bored Bob", { personality: { curious: 0.1 } });
  const now = new Date(2026, 5, 1, 23, 0).getTime();
  // First update initializes; second should be returning home → success.
  let r = action.update({ player, nowMs: now });
  assert.ok(["running", "success"].includes(r));
  // Walk home: position at home tile → success.
  player.position = { x: 3200, y: 3200, z: 0 };
  player.getPosition = () => player.position;
  for (let i = 0; i < 5; i++) {
    r = action.update({ player, nowMs: now + i * 1000 });
    if (r === "success") break;
  }
  assert.strictEqual(r, "success");
  assert.strictEqual(Astro.astronomerFor("Bored Bob"), null);
});

test("daytime gives honest success", () => {
  forceNight = false;
  Astro.registerAstronomer("Day Watcher", "varrock");
  const action = createCitizenObserveAction({}, {});
  const player = stubPlayer("Day Watcher", { personality: { curious: 0.9 } });
  const now = new Date(2026, 5, 1, 12, 0).getTime();
  const r = action.update({ player, nowMs: now });
  assert.strictEqual(r, "success");
  assert.strictEqual(Astro.chartsFor("varrock").length, 0);
});

test("night observation walks to observatory", () => {
  Astro.registerAstronomer("Walker", "varrock");
  const action = createCitizenObserveAction({}, {});
  const player = stubPlayer("Walker", {
    personality: { curious: 0.9 },
    position: { x: 0, y: 0, z: 0 },
  });
  const now = new Date(2026, 5, 1, 23, 0).getTime();
  const r = action.update({ player, nowMs: now });
  assert.strictEqual(r, "running");
  assert.ok(player.__movedTo, "expected a movement request");
});

test("observation session creates a chart", () => {
  Astro.registerAstronomer("Charter", "varrock");
  const action = createCitizenObserveAction({}, {});
  // Start at the REAL observatory tile (market +40/-40 per CitizenAstronomy).
  const obsTile = { x: 3280, y: 3120, z: 0 };
  const player = stubPlayer("Charter", {
    personality: { curious: 0.9 },
    position: obsTile,
  });
  let now = new Date(2026, 5, 1, 23, 0).getTime();
  let r = action.update({ player, nowMs: now });
  assert.strictEqual(r, "running"); // outbound → observing
  // Run observation rounds (cooldown-gated).
  for (let i = 0; i < 10; i++) {
    now += 25000;
    r = action.update({ player, nowMs: now });
    if (r === "success") break;
  }
  const charts = Astro.chartsFor("varrock");
  assert.ok(charts.length >= 1, "expected a chart to be created");
  assert.strictEqual(charts[0].astronomer, "Charter");
});

test("give-up timeout returns success", () => {
  Astro.registerAstronomer("Quitter", "varrock");
  const action = createCitizenObserveAction({}, {});
  const player = stubPlayer("Quitter", {
    personality: { curious: 0.9 },
    position: { x: 0, y: 0, z: 0 },
  });
  const now = new Date(2026, 5, 1, 23, 0).getTime();
  action.update({ player, nowMs: now });
  const r = action.update({ player, nowMs: now + 11 * 60 * 1000 });
  assert.strictEqual(r, "success");
});

test("curious first-timer gets registered", () => {
  const action = createCitizenObserveAction({}, {});
  const player = stubPlayer("Newbie", { personality: { curious: 0.95 } });
  const now = new Date(2026, 5, 1, 23, 0).getTime();
  action.update({ player, nowMs: now });
  assert.ok(Astro.astronomerFor("Newbie"), "expected Newbie to be registered");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
