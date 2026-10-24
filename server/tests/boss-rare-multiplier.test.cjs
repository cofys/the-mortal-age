// Run after `yarn build`: node --test tests/boss-rare-multiplier.test.cjs
// world.json pluginConfig "NpcDrops:bossRareMultiplier" makes a boss's rare drops that many times
// likelier (docs/npc-drops.md).
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const NpcDrops = require("../plugins/npcs/NpcDrops.plugin");

const config = {};
const random = Math.random;

before(() => {
  CachePipeline.initialize();
  NpcDrops.register({
    core: { CacheDefinitions },
    getPluginConfig: (key, fallback) => (key in config ? config[key] : fallback),
    getItemOnGroundManager() {},
    onCustomEvent() {},
    emitCustomEvent() {},
    onNpcDeath() {},
    registerCommand() {},
    log() {},
  });
  NpcDrops._test.loadDrops();
});

after(() => {
  Math.random = random;
});

/** Item ids one kill of `table` drops, every roll landing at `roll` (0..1). */
function dropsAt(table, roll, multiplier) {
  config["NpcDrops:bossRareMultiplier"] = multiplier;
  Math.random = () => roll;
  try {
    return NpcDrops.__internals.rollTable(table, null, null).map((drop) => drop.itemId);
  } finally {
    Math.random = random;
  }
}

const table = (boss) => ({
  boss,
  entries: [
    { item_id: 1, separate_roll: true, weight: 1, out_of: 400 },
    { item_id: 2, separate_roll: true, weight: 1, out_of: 10 },
  ],
  tertiary: [{ item_id: 3, weight: 1, out_of: 400 }],
});

test("the cache's boss param marks boss tables, and only those", () => {
  const graardor = NpcDrops._test.tablesByNpc.get(2215)[0];
  assert.equal(graardor.boss, true, "General Graardor");
  const goblin = NpcDrops._test.tablesByNpc.get(3029)[0];
  assert.notEqual(goblin.boss, true, "goblin");
});

test("a boss's rare separate and tertiary rolls are that many times likelier", () => {
  // 1.5/400: misses a 1/400 roll, hits a 2/400 one.
  assert.deepEqual(dropsAt(table(true), 1.5 / 400, 1), [2]);
  assert.deepEqual(dropsAt(table(true), 1.5 / 400, 2), [1, 2, 3]);
});

test("common drops and other monsters' drops keep their rates", () => {
  // 1.5/10 misses the 1/10 roll, and would hit it if it were doubled.
  assert.deepEqual(dropsAt(table(true), 1.5 / 10, 2), []);
  assert.deepEqual(dropsAt(table(false), 1.5 / 400, 2), [2]);
});

test("a missing or unusable setting is the OSRS rate", () => {
  for (const multiplier of [undefined, "fast", 0.5, -2]) {
    assert.deepEqual(dropsAt(table(true), 1.5 / 400, multiplier), [2], String(multiplier));
  }
});
