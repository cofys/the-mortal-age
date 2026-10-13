"use strict";

/**
 * CitizenDestinationSpread — destack regression lock (Jon 2026-10-12).
 *
 * Jon's in-game read: 7 citizens stacked on the exact same tile (2945,3369) —
 * in-game that reads as one static pile. Root causes: CitizenCelebrate
 * walked every celebrant to the exact market anchor tile, and the social /
 * gather / caravan-follow paths had no coordination across citizens.
 *
 * These tests drive the real actions (real CitizenSlotCapacity, real
 * humanizer) with stubbed engine modules and assert the fix contract:
 *   - N citizens sharing one destination get N DISTINCT nearby tiles
 *     (spiral-ring slots), never the identical tile.
 *   - Tiles stay within a tight ring of the real anchor (crowd clustering
 *     preserved — a tavern is full, not empty).
 *   - Fallbacks stay finite when slots are full.
 */

const assert = require("node:assert/strict");

const TAVERN = { x: 2945, y: 3369, z: 0 }; // the actual stacked tile from the incident
const MARKET = { x: 3000, y: 3000, z: 0 };
const WAYPOINT = { x: 3100, y: 3100, z: 0 };
const GROVE = { x: 3200, y: 3200, z: 0, id: "oaks", radius: 6 };

// --- engine stubs (same pattern as CitizenRoutine.test.js) --------------------

const movementTargets = new Map(); // username -> [{x, y}]

function stubEngineModules() {
  const stubs = {
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y) => {
        const name = player.getUsername();
        if (!movementTargets.has(name)) movementTargets.set(name, []);
        movementTargets.get(name).push({ x, y });
        return true;
      },
      clearMovementRequest: () => {},
    },
    "../CitizenSites": {
      siteTile: (player, kind) => (kind === "market" ? MARKET : TAVERN),
      kingdomIdOf: () => "misthalin",
      pickPlace: () => GROVE,
    },
    "../../CitizenEvents": {
      isKingdomAtWar: () => false,
    },
    "../../chat/CitizenSayPublic": {
      sayPublic: () => {},
    },
    "../../lib/CitizenTradeCaravans": {
      getCaravanById: () => ({
        visible: true,
        walkPath: [WAYPOINT],
        waypointIndex: 0,
      }),
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const path = require.resolve(rel);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
}
stubEngineModules();

const SlotCapacity = require("../CitizenSlotCapacity");
const { createIdleSocialAction } = require("./IdleSocial");
const { createCitizenGoToPlaceAction } = require("./CitizenGoToPlace");
const { createCitizenCelebrateAction } = require("./CitizenCelebrate");
const { createCaravanWalkAction } = require("./CaravanWalk");
const { ATTR_CARAVAN_DUTY } = require("../../constants");

// --- fakes -------------------------------------------------------------------

function fakePlayer(username, farTile) {
  const loc = {
    getX: () => farTile.x,
    getY: () => farTile.y,
    getZ: () => farTile.z ?? 0,
  };
  return {
    getUsername: () => username,
    username,
    getLocation: () => loc,
    getPosition: () => ({ x: farTile.x, y: farTile.y, z: farTile.z ?? 0 }),
    getAttribute: (key) => (key === ATTR_CARAVAN_DUTY ? "caravan-1" : undefined),
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
  };
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function distinctTiles(targets) {
  return new Set(targets.map((t) => `${t.x},${t.y}`));
}

function maxPile(targets) {
  const counts = new Map();
  for (const t of targets) {
    const k = `${t.x},${t.y}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Math.max(...counts.values());
}

// --- tiny runner --------------------------------------------------------------

let failures = 0;
function test(name, fn) {
  SlotCapacity.resetForTests();
  movementTargets.clear();
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL - ${name}: ${e.message}`);
  }
}

function drive(action, players, ticks = 5) {
  for (let t = 0; t < ticks; t++) {
    for (const p of players) {
      action.update({ player: p, nowMs: Date.now() + t * 1000 });
    }
  }
}

function firstTargets(players) {
  return players.map((p) => movementTargets.get(p.getUsername())[0]);
}

// --- the contract -------------------------------------------------------------

test("tavern social: 7 citizens get 7 distinct tiles near the anchor", () => {
  const action = createIdleSocialAction(
    { anchorKind: "tavern", activityId: "tavern_social" },
    {}
  );
  const players = Array.from(
    { length: 7 },
    (_, i) => fakePlayer(`tavern-goer-${i}`, { x: 2900, y: 3300, z: 0 })
  );
  drive(action, players);
  const targets = firstTargets(players);
  assert.equal(
    distinctTiles(targets).size,
    7,
    `expected 7 distinct tiles, got ${JSON.stringify(targets)}`
  );
  for (const t of targets) {
    assert.ok(
      chebyshev(t, TAVERN) <= 5,
      `tile ${t.x},${t.y} within crowd ring of the tavern anchor`
    );
    assert.ok(
      !(t.x === TAVERN.x && t.y === TAVERN.y),
      "nobody stands on the exact anchor tile"
    );
  }
});

test("gather: citizens at one grove never pile 3+ on a tile", () => {
  const action = createCitizenGoToPlaceAction({ kind: "tree" }, {});
  const players = Array.from(
    { length: 6 },
    (_, i) => fakePlayer(`chopper-${i}`, { x: 3150, y: 3150, z: 0 })
  );
  drive(action, players);
  const targets = firstTargets(players);
  assert.ok(
    maxPile(targets) <= 2,
    `no 3+ pile at the grove, got ${JSON.stringify(targets)}`
  );
  for (const t of targets) {
    assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), "finite target tile");
    assert.ok(chebyshev(t, GROVE) <= 10, "within the grove's working radius");
  }
});

test("celebrate: 5 celebrants get 5 distinct tiles at the market", () => {
  // canStart is not under test; drive tick() straight into the outbound phase.
  const action = createCitizenCelebrateAction({}, {});
  const players = Array.from(
    { length: 5 },
    (_, i) => fakePlayer(`reveller-${i}`, { x: 2900, y: 2900, z: 0 })
  );
  for (let t = 0; t < 5; t++) {
    for (const p of players) action.tick(p);
  }
  const targets = firstTargets(players);
  assert.equal(
    distinctTiles(targets).size,
    5,
    `expected 5 distinct venue tiles, got ${JSON.stringify(targets)}`
  );
  for (const t of targets) {
    assert.ok(
      chebyshev(t, MARKET) <= 8,
      `tile ${t.x},${t.y} within the venue crowd radius`
    );
  }
});

test("caravan: 4 crew get 4 distinct tiles around the waypoint (follow cap)", () => {
  const action = createCaravanWalkAction({}, {});
  const players = Array.from(
    { length: 4 },
    (_, i) => fakePlayer(`crew-${i}`, { x: 3050, y: 3050, z: 0 })
  );
  drive(action, players);
  const targets = firstTargets(players);
  assert.equal(
    distinctTiles(targets).size,
    4,
    `expected 4 distinct crew tiles, got ${JSON.stringify(targets)}`
  );
  for (const t of targets) {
    const d = chebyshev(t, WAYPOINT);
    assert.ok(d >= 1 && d <= 5, `crew keeps a 1-5 tile offset (got ${d})`);
  }
});

test("full slots degrade to finite personal-ring tiles, never NaN", () => {
  // Saturate the tavern's 8 slots, then one more citizen must still walk
  // somewhere finite (the noisyTile fallback).
  const action = createIdleSocialAction(
    { anchorKind: "tavern", activityId: "tavern_social" },
    {}
  );
  const players = Array.from(
    { length: 9 },
    (_, i) => fakePlayer(`late-goer-${i}`, { x: 2900, y: 3300, z: 0 })
  );
  drive(action, players);
  const targets = firstTargets(players);
  assert.equal(targets.length, 9, "every citizen got a movement target");
  for (const t of targets) {
    assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), "finite target tile");
  }
  assert.ok(maxPile(targets) <= 2, "even over capacity, no 3+ pile");
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all destination-spread tests pass");
