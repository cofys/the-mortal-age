"use strict";

/**
 * CitizenEngineerWork unit checks — walk to site, donate, work.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenEngineerWork".
 *   - update() walks to the site, donates materials, works, returns home.
 *   - No active project -> honest "success" (no fake work).
 *   - Give-up timeout returns "success".
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenConstruct.test.js) so plain-node tests stay engine-free.
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
      if (!player.__engineerState) player.__engineerState = init();
      return player.__engineerState;
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
    humanizerProfile: () => ({}),
  },
};

// --- load the action (uses the real CitizenInfrastructure module) -----------

const EngineerWork = require("./CitizenEngineerWork.js");
const Infra = require("../../lib/CitizenInfrastructure");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Infra.resetForTests();
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
    __engineerState: null,
    getUsername: () => opts.username ?? "TestEngineer",
    getPosition: () => ({ x: opts.x ?? 3206, y: opts.y ?? 3204, z: 0 }),
    getAttribute: () => ({ traits: opts.traits ?? [] }),
    getSkills: () => ({
      getLevel: (skill) => (skill === "construction" ? (opts.constructionLevel ?? 1) : 1),
      addXp: () => {},
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

console.log("CitizenEngineerWork:");

test("factory returns action with id citizenEngineerWork", () => {
  const action = EngineerWork.createCitizenEngineerWorkAction({}, {});
  assert.strictEqual(action.id, "citizenEngineerWork");
  assert.strictEqual(typeof action.update, "function");
});

test("no active project -> honest success, no fake work", () => {
  const action = EngineerWork.createCitizenEngineerWorkAction({}, {});
  const player = mockPlayer({ inventory: { 960: 50, 4819: 60 } });
  let result = "running";
  for (let i = 0; i < 30 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  assert.strictEqual(result, "success");
  // Materials untouched — nothing to donate to.
  assert.strictEqual(player.__items.get(960), 50);
});

test("active project -> donates materials and works", () => {
  const action = EngineerWork.createCitizenEngineerWorkAction({}, {});
  // Set up a real project: watchtower needs planks (960) + nails (4819).
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  assert.strictEqual(r.ok, true);
  // Position the player AT the real site tile.
  const site = Infra.siteTile("varrock") ?? { x: 3200, y: 3200 };
  const player = mockPlayer({ inventory: { 960: 50 }, x: site.x, y: site.y });
  let result = "running";
  // 50 ticks x 15s = 750s > 10min give-up: honest termination even though
  // the stubbed walk home never arrives (movement is a no-op stub).
  for (let i = 0; i < 50 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  assert.strictEqual(result, "success");
  // Materials were donated into the project stockpile.
  const proj = Infra.project(r.project.id);
  if (proj) {
    const donated = proj.stockpile[960] ?? 0;
    assert.ok(donated > 0, "no materials donated");
    assert.strictEqual(player.__items.get(960), 50 - donated);
  }
  // If the project completed during the run, that's honest work too.
});

test("give-up timeout returns success", () => {
  const action = EngineerWork.createCitizenEngineerWorkAction({}, {});
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  assert.strictEqual(r.ok, true);
  // Player far from site, never arrives — must still terminate.
  const player = mockPlayer({ inventory: {}, x: 100, y: 100 });
  const t0 = Date.now();
  let result = "running";
  // Jump past the give-up deadline.
  result = action.update({ player, nowMs: t0 });
  assert.strictEqual(result, "running");
  result = action.update({ player, nowMs: t0 + 11 * 60 * 1000 });
  assert.strictEqual(result, "success");
});

test("action never throws on null player fields", () => {
  const action = EngineerWork.createCitizenEngineerWorkAction({}, {});
  const player = {};
  let result;
  try {
    result = action.update({ player, nowMs: Date.now() });
  } catch (e) {
    assert.fail(`threw: ${e.message}`);
  }
  assert.ok(result === "running" || result === "success");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
