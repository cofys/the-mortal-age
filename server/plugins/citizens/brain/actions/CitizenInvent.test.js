"use strict";

/**
 * CitizenInvent unit checks — walk to workshop, research, invent.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenInvent".
 *   - update() walks to workshop, starts research, tinkers, returns home.
 *   - No materials → honest "success" (no fake research).
 *   - Give-up timeout returns "success".
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenExplore.test.js) so plain-node tests stay engine-free.
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
      if (!player.__inventState) player.__inventState = init();
      return player.__inventState;
    },
  },
};

// Stub BotNavigation: no-op movement.
const navPath = path.resolve(
  __dirname, "../../../bots/behaviours/navigation/BotNavigation.js"
);
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: () => {},
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
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

// Stub constants.
const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizen:personality" },
};

// Stub humanizer.
const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: (seed) => {
      let s = 0;
      for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0;
      return () => {
        s = (s * 1103515245 + 12345) >>> 0;
        return (s % 1000) / 1000;
      };
    },
    personalSpot: (player, x, y, z) => ({ x, y, z }),
    humanizerProfile: () => ({}),
  },
};

// --- load the action (uses the real CitizenInventions module) ---------------

const Invent = require("./CitizenInvent.js");
const Inventions = require("../../lib/CitizenInventions");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Inventions.resetForTests();
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}: ${e.message}\n${e.stack}`);
  }
}

// Minimal player stub with real inventory.
function mockPlayer(opts = {}) {
  const items = new Map(Object.entries(opts.inventory ?? {}).map(([k, v]) => [Number(k), v]));
  const player = {
    __inventState: null,
    getUsername: () => opts.username ?? "TestInventor",
    getX: () => opts.x ?? 3200,
    getY: () => opts.y ?? 3200,
    getAttribute: () => ({ traits: opts.traits ?? [] }),
    getSkills: () => ({
      getLevel: (skill) => (skill === "crafting" ? (opts.craftingLevel ?? 1) : 1),
    }),
    getInventory: () => ({
      getAmount: (id) => items.get(Number(id)) ?? 0,
      deleteNumber: (id, n) => {
        const have = items.get(Number(id)) ?? 0;
        items.set(Number(id), Math.max(0, have - n));
      },
    }),
    // Expose for assertions.
    __items: items,
  };
  return player;
}

console.log("CitizenInvent:");

test("factory returns action with id citizenInvent", () => {
  const action = Invent.createCitizenInventAction({}, {});
  assert.strictEqual(action.id, "citizenInvent");
  assert.strictEqual(typeof action.update, "function");
});

test("no materials -> walks home honestly (success)", () => {
  const action = Invent.createCitizenInventAction({}, {});
  const player = mockPlayer({ craftingLevel: 50 }); // high level, empty inventory
  // Run enough ticks to walk to workshop and discover no materials.
  let result = "running";
  for (let i = 0; i < 50 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  // Should end in success (either at workshop with no materials, or give-up).
  assert.ok(result === "success", `expected success, got ${result}`);
  // No research project should have been started.
  assert.strictEqual(Inventions.activeProjects().length, 0);
});

test("affordable blueprint -> starts research and consumes materials", () => {
  const action = Invent.createCitizenInventAction({}, {});
  // Give materials for improved_pickaxe: 2x iron bar (2351), 1x oak planks (8778).
  const player = mockPlayer({
    craftingLevel: 25,
    inventory: { 2351: 5, 8778: 3 },
    x: 3218, y: 3212, // already at workshop (stub tile is 3200,3200 + offset)
  });
  let result = "running";
  for (let i = 0; i < 50 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  // A research project should exist.
  const projects = Inventions.activeProjects();
  assert.ok(projects.length > 0, "expected a research project to be started");
  // Materials should have been consumed.
  const ironLeft = player.__items.get(2351);
  assert.ok(ironLeft < 5, `iron bars should be consumed, ${ironLeft} left`);
});

test("give-up timeout returns success", () => {
  const action = Invent.createCitizenInventAction({}, {});
  const player = mockPlayer({ x: 0, y: 0 }); // far from workshop
  // First tick initializes giveUpAt.
  action.update({ player, nowMs: 1000000 });
  // Jump past the give-up time (10 min).
  const result = action.update({ player, nowMs: 1000000 + 11 * 60 * 1000 });
  assert.strictEqual(result, "success");
});

test("active project resumes instead of starting new", () => {
  const action = Invent.createCitizenInventAction({}, {});
  // Start a project directly in the data tier.
  Inventions.startResearch("TestInventor", "improved_pickaxe");
  const player = mockPlayer({
    username: "TestInventor",
    craftingLevel: 25,
    inventory: { 2351: 5, 8778: 3 },
    x: 3218, y: 3212,
  });
  let result = "running";
  for (let i = 0; i < 30 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  // Should still be exactly 1 project (resumed, not duplicated).
  assert.strictEqual(Inventions.activeProjects().length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
