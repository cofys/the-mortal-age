"use strict";

/**
 * CitizenRealWork unit checks — Jon 2026-10-13: no fake skilling.
 *
 * Proves the real-interaction contracts without a running server:
 *  - fishing: no live spot nearby -> false (no animation, no yield, no click);
 *    live spot in reach -> the REAL npc interaction is emitted (clickType for
 *    the net); an already-running plugin session -> "active" (hands off).
 *  - woodcutting/mining: no tree/rock nearby -> false; target in reach ->
 *    the REAL object interaction is emitted with clickType 1.
 *  - a busy movement queue is never fought (driver yields to the brain).
 *  - full inventory -> no click (the bank hinge owns that state).
 *
 * Engine modules (skill plugins, object catalog, CitizenTiles) are stubbed
 * in the require cache — same pattern as CitizenRoutine.test.js.
 */
const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

function stubEngineModules() {
  const stubs = {
    "../../skills/Fishing.plugin": {
      FISHING_SPOT_NAMES: ["Fishing spot", "Rod Fishing spot"],
      spotTools: () => [{ clickType: 1, tool: "NET" }],
      isFishingActive: (bot) => bot.__fishingActive === true,
    },
    "../../skills/Woodcutting.plugin": {
      isWoodcuttingActive: (bot) => bot.__wcActive === true,
    },
    "../../skills/Mining.plugin": {
      isMiningActive: (bot) => bot.__miningActive === true,
    },
    "../../bots/brain/BotObjectCatalog": {
      resolveCatalogObjectIds: ({ catalog }) =>
        catalog === "tree" ? [1276] : [2090],
    },
    "../brain/actions/CitizenGoToPlace": {
      _tierTables: (kind) =>
        kind === "tree"
          ? [
              { tier: "willow", level: 30 },
              { tier: "normal", level: 1 },
            ]
          : [
              { tier: "coal", level: 30 },
              { tier: "copper", level: 1 },
            ],
      _targetTierFor: (level, tiers) => {
        for (const t of tiers) if (level >= t.level) return t.tier;
        return null;
      },
    },
    "../brain/CitizenGoalResolver": {
      skillLevel: () => 1,
    },
    "./CitizenTiles": {
      isWaterTile: () => false,
      isBlockedTile: () => false,
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const path = require.resolve(rel);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
}
stubEngineModules();

const { drive, isWorking, _resetForTests } = require("./CitizenRealWork");

function mockLoc(x, y, z = 0) {
  return {
    _x: x,
    _y: y,
    _z: z,
    getX() {
      return this._x;
    },
    getY() {
      return this._y;
    },
    getZ() {
      return this._z;
    },
    clone() {
      const c = mockLoc(this._x, this._y, this._z);
      return c;
    },
    setX(v) {
      this._x = v;
    },
    setY(v) {
      this._y = v;
    },
  };
}

function mockBot(opts = {}) {
  const {
    x = 3090,
    y = 3235,
    name = "Test Citizen",
    queueSize = 0,
    invFull = false,
  } = opts;
  const queue = {
    _size: queueSize,
    size() {
      return this._size;
    },
    walked: [],
    walkToTile(dest, cb) {
      this.walked.push({ dest, cb });
      this._size = 1;
    },
    walkToObject(obj, o) {
      this.walked.push({ obj, opts: o });
      this._size = 1;
    },
  };
  const amounts = {};
  const inv = {
    isFull: () => invFull,
    getAmount: (id) => amounts[id] ?? 0,
    adds: (id, n) => {
      amounts[id] = (amounts[id] ?? 0) + n;
    },
  };
  return {
    getUsername: () => name,
    getLocation: () => mockLoc(x, y),
    getMovementQueue: () => queue,
    getInventory: () => inv,
    getPrivateArea: () => null,
    forcePositionToFace: () => {},
    __queue: queue,
  };
}

function mockSpot(x, y) {
  return {
    isRegistered: () => true,
    getId: () => 1526,
    getIndex: () => 7,
    getDefinition: () => ({
      getName: () => "Fishing spot",
      getActions: () => ["Net"],
    }),
    getLocation: () => mockLoc(x, y),
  };
}

function mockObject(x, y, id) {
  return {
    isRegistered: () => true,
    getId: () => id,
    getLocation: () => mockLoc(x, y),
  };
}

function mockApi({ npcs = [], objects = [] } = {}) {
  const emitted = [];
  const api = {
    core: {
      World: {
        getNpcsNear: () => npcs,
        getObjects: () => objects,
      },
    },
    emitNpcInteraction: (e) => {
      emitted.push({ kind: "npc", e });
      return true;
    },
    emitObjectInteraction: (e) => {
      emitted.push({ kind: "obj", e });
      return true;
    },
    log: () => {},
  };
  return { api, emitted };
}

describe("CitizenRealWork — real fishing", () => {
  test("no spot nearby: no click, no animation, no yield", () => {
    _resetForTests();
    const { api, emitted } = mockApi({ npcs: [] });
    const bot = mockBot();
    assert.equal(drive(api, bot, "fishing", { leader: true }), false);
    assert.equal(emitted.length, 0);
    assert.equal(bot.__queue.walked.length, 0);
  });

  test("spot in reach: emits the real NPC interaction", () => {
    _resetForTests();
    const spot = mockSpot(3092, 3235);
    const { api, emitted } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(drive(api, bot, "fishing", { leader: false }), "engaged");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "npc");
    assert.equal(emitted[0].e.npcId, 1526);
    assert.equal(emitted[0].e.clickType, 1);
    assert.equal(emitted[0].e.handled, false);
  });

  test("running plugin session: hands off, no click", () => {
    _resetForTests();
    const spot = mockSpot(3092, 3235);
    const { api, emitted } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235 });
    bot.__fishingActive = true;
    assert.equal(drive(api, bot, "fishing", { leader: true }), "active");
    assert.equal(emitted.length, 0);
  });

  test("busy movement queue: driver yields, no fight", () => {
    _resetForTests();
    const spot = mockSpot(3092, 3235);
    const { api, emitted } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235, queueSize: 3 });
    assert.equal(drive(api, bot, "fishing", { leader: true }), false);
    assert.equal(emitted.length, 0);
  });

  test("leader walks to an adjacent land tile, then clicks", () => {
    _resetForTests();
    const spot = mockSpot(3095, 3235);
    const { api, emitted } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(drive(api, bot, "fishing", { leader: true }), "engaged");
    assert.equal(bot.__queue.walked.length, 1);
    const dest = bot.__queue.walked[0].dest;
    // Adjacent to the spot (ring 1), not on it.
    assert.ok(Math.max(Math.abs(dest.getX() - 3095), Math.abs(dest.getY() - 3235)) === 1);
    // Arrival re-clicks the live spot.
    bot.__queue.walked[0].cb();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].e.npcId, 1526);
  });

  test("member does not walk: opportunistic clicks only", () => {
    _resetForTests();
    const spot = mockSpot(3095, 3235);
    const { api, emitted } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(drive(api, bot, "fishing", { leader: false }), false);
    assert.equal(emitted.length, 0);
    assert.equal(bot.__queue.walked.length, 0);
  });

  test("full inventory: no click", () => {
    _resetForTests();
    const spot = mockSpot(3092, 3235);
    const { api, emitted } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235, invFull: true });
    assert.equal(drive(api, bot, "fishing", { leader: true }), false);
    assert.equal(emitted.length, 0);
  });
});

describe("CitizenRealWork — real woodcutting/mining", () => {
  test("no tree nearby: false, nothing emitted", () => {
    _resetForTests();
    const { api, emitted } = mockApi({ objects: [] });
    const bot = mockBot();
    assert.equal(drive(api, bot, "woodcutting", { leader: true }), false);
    assert.equal(emitted.length, 0);
  });

  test("tree in reach: emits the real object interaction", () => {
    _resetForTests();
    const tree = mockObject(3091, 3235, 1276);
    const { api, emitted } = mockApi({ objects: [tree] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(drive(api, bot, "woodcutting", { leader: false }), "engaged");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "obj");
    assert.equal(emitted[0].e.objectId, 1276);
    assert.equal(emitted[0].e.clickType, 1);
  });

  test("running woodcutting session: hands off", () => {
    _resetForTests();
    const tree = mockObject(3091, 3235, 1276);
    const { api, emitted } = mockApi({ objects: [tree] });
    const bot = mockBot({ x: 3090, y: 3235 });
    bot.__wcActive = true;
    assert.equal(drive(api, bot, "woodcutting", { leader: true }), "active");
    assert.equal(emitted.length, 0);
  });

  test("rock in reach: emits the real object interaction", () => {
    _resetForTests();
    const rock = mockObject(3091, 3235, 2090);
    const { api, emitted } = mockApi({ objects: [rock] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(drive(api, bot, "mining", { leader: false }), "engaged");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].e.objectId, 2090);
    assert.equal(emitted[0].e.clickType, 1);
  });

  test("leader walks into reach via walkToObject", () => {
    _resetForTests();
    const tree = mockObject(3100, 3235, 1276);
    const { api, emitted } = mockApi({ objects: [tree] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(drive(api, bot, "woodcutting", { leader: true }), "engaged");
    assert.equal(bot.__queue.walked.length, 1);
    assert.equal(bot.__queue.walked[0].obj, tree);
    // Arrival clicks the live object.
    bot.__queue.walked[0].opts.execute();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].e.objectId, 1276);
  });

  test("isWorking reflects engagement", () => {
    _resetForTests();
    const spot = mockSpot(3095, 3235);
    const { api } = mockApi({ npcs: [spot] });
    const bot = mockBot({ x: 3090, y: 3235 });
    assert.equal(isWorking(api, bot, "fishing"), false);
    drive(api, bot, "fishing", { leader: true }); // engaged: walking
    assert.equal(isWorking(api, bot, "fishing"), true);
  });
});
