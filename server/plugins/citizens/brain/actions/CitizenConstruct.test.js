"use strict";

/**
 * CitizenConstruct unit checks — walk to site, donate, work.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenConstruct".
 *   - update() walks to the site, donates materials, works, returns home.
 *   - No active project -> honest "success" (no fake work).
 *   - Give-up timeout returns "success".
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenInvent.test.js) so plain-node tests stay engine-free.
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
      if (!player.__constructState) player.__constructState = init();
      return player.__constructState;
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

// --- load the action (uses the real CitizenConstruction module) -------------

const Construct = require("./CitizenConstruct.js");
const Construction = require("../../lib/CitizenConstruction");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Construction.resetForTests();
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
    __constructState: null,
    getUsername: () => opts.username ?? "TestBuilder",
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

console.log("CitizenConstruct:");

test("factory returns action with id citizenConstruct", () => {
  const action = Construct.createCitizenConstructAction({}, {});
  assert.strictEqual(action.id, "citizenConstruct");
  assert.strictEqual(typeof action.update, "function");
});

test("no active project -> honest success, no fake work", () => {
  const action = Construct.createCitizenConstructAction({}, {});
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
  const action = Construct.createCitizenConstructAction({}, {});
  // Set up a real project: granary needs planks (960) + nails (4819).
  const bp = Construction.createBlueprint("bob", "granary");
  const r = Construction.commissionProject("varrock", bp.id, "bob");
  // Position the player AT the real site tile.
  const site = Construction.siteTile("varrock") ?? { x: 3200, y: 3200 };
  const player = mockPlayer({ inventory: { 960: 50 }, x: site.x, y: site.y });
  let result = "running";
  for (let i = 0; i < 40 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  assert.strictEqual(result, "success");
  // Materials were donated into the project stockpile.
  const proj = Construction.project(r.id);
  const donated = proj.materialsDonated[960] ?? 0;
  assert.ok(donated > 0, `expected planks donated, got ${donated}`);
  // Player inventory decreased.
  assert.ok(player.__items.get(960) < 50, "inventory should decrease");
});

test("give-up timeout returns success", () => {
  const action = Construct.createCitizenConstructAction({}, {});
  const bp = Construction.createBlueprint("bob", "granary");
  Construction.commissionProject("varrock", bp.id, "bob");
  const player = mockPlayer({ x: 0, y: 0 }); // far from site
  action.update({ player, nowMs: 1000000 });
  const result = action.update({ player, nowMs: 1000000 + 11 * 60 * 1000 });
  assert.strictEqual(result, "success");
});

test("hands-on work advances project progress", () => {
  const action = Construct.createCitizenConstructAction({}, {});
  const bp = Construction.createBlueprint("bob", "granary");
  const r = Construction.commissionProject("varrock", bp.id, "bob");
  const p = Construction.project(r.id);
  // Fully stock materials so the project is in building phase.
  Construction.donateMaterials(r.id, Object.assign({}, p.materialsNeeded));
  assert.strictEqual(Construction.project(r.id).status, "building");
  const before = Construction.project(r.id).progress;
  const site = Construction.siteTile("varrock") ?? { x: 3200, y: 3200 };
  const player = mockPlayer({ x: site.x, y: site.y });
  let result = "running";
  for (let i = 0; i < 40 && result === "running"; i++) {
    result = action.update({ player, nowMs: Date.now() + i * 15000 });
  }
  const after = Construction.project(r.id).progress;
  assert.ok(after > before, `progress should advance: ${before} -> ${after}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
