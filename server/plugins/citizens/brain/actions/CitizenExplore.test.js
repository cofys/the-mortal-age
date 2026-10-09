"use strict";

/**
 * CitizenExplore unit checks — venture into the wilderness, search, discover.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenExplore".
 *   - _hunterLevel falls back to 1 when unreadable.
 *   - _discoveryChance scales with Hunter level and curiosity.
 *   - _dangerChance decreases with Hunter level (floor 0.05).
 *   - _pickDiscoveryType returns valid types.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenThieve.test.js) so plain-node tests stay engine-free.
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
      if (!player.__exploreState) player.__exploreState = init();
      return player.__exploreState;
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

// Stub Hunter plugin: hunterLevel reads the stub skill level.
const hunterPath = path.resolve(__dirname, "../../../skills/Hunter.plugin.js");
require.cache[hunterPath] = {
  id: hunterPath, filename: hunterPath, loaded: true,
  exports: {
    hunterLevel: (player) => {
      try {
        return player.getSkills?.().getLevel?.(16) ?? 1;
      } catch {
        return 1;
      }
    },
  },
};

// --- load the action ---------------------------------------------------------

const Explore = require("./CitizenExplore.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

console.log("CitizenExplore:");

test("factory returns action with id citizenExplore", () => {
  const action = Explore.createCitizenExploreAction({}, {});
  assert.strictEqual(action.id, "citizenExplore");
  assert.strictEqual(typeof action.update, "function");
});

test("_hunterLevel falls back to 1 when unreadable", () => {
  assert.strictEqual(Explore._hunterLevel({}), 1);
});

test("_discoveryChance increases with Hunter level", () => {
  const low = Explore._discoveryChance(
    { getSkills: () => ({ getLevel: () => 1 }) }, {}
  );
  const high = Explore._discoveryChance(
    { getSkills: () => ({ getLevel: () => 50 }) }, {}
  );
  assert.ok(high > low, `high (${high}) should exceed low (${low})`);
});

test("_discoveryChance boosts curious personalities", () => {
  const player = { getSkills: () => ({ getLevel: () => 10 }) };
  const plain = Explore._discoveryChance(player, { traits: [] });
  const curious = Explore._discoveryChance(player, { traits: ["curious"] });
  assert.ok(curious > plain);
});

test("_discoveryChance caps at 0.50", () => {
  const player = { getSkills: () => ({ getLevel: () => 99 }) };
  const c = Explore._discoveryChance(player, { traits: ["curious"] });
  assert.ok(c <= 0.50);
});

test("_dangerChance decreases with Hunter level", () => {
  const low = Explore._dangerChance(
    { getSkills: () => ({ getLevel: () => 1 }) }
  );
  const high = Explore._dangerChance(
    { getSkills: () => ({ getLevel: () => 99 }) }
  );
  assert.ok(high < low);
});

test("_dangerChance has a 0.05 floor", () => {
  const c = Explore._dangerChance(
    { getSkills: () => ({ getLevel: () => 99 }) }
  );
  assert.ok(c >= 0.05);
});

test("_pickDiscoveryType returns valid types", () => {
  const valid = ["resource_node", "dungeon_entrance", "trade_route", "ancient_ruin", "monster_lair"];
  for (const r of [0.0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    const t = Explore._pickDiscoveryType(() => r);
    assert.ok(valid.includes(t), `unexpected type: ${t}`);
  }
});

test("action gives up after GIVE_UP_MS", () => {
  const action = Explore.createCitizenExploreAction({}, {});
  const player = {
    __exploreState: null,
    getUsername: () => "Test",
    getAttribute: () => ({}),
    getX: () => 3200, getY: () => 3200,
  };
  // First tick initializes.
  const r1 = action.update({ player, nowMs: 1000 });
  assert.strictEqual(r1, "running");
  // Far future tick hits give-up.
  const r2 = action.update({ player, nowMs: 1000 + Explore.GIVE_UP_MS + 1 });
  assert.strictEqual(r2, "success");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
