// Run after `yarn build`: node --test tests/npc-default-facing.test.cjs
// A spawn without a direction faces the cache's default, south, as live OSRS NPCs stand (rsprox
// captures); before, the cache value was read in the wrong numbering and they all faced north.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Direction } = require("../dist/game/model/Direction");
const { NpcSpawnDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcSpawnDefinitionLoader");

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
});

const facing = (raw) => new NpcSpawnDefinitionLoader().toDefinition({ x: 3088, y: 3242, level: 0, ...raw }, "test").getFacing();

test("a spawn without a direction faces south, the cache's default", () => {
  // Iffie (2899) and a Draynor banker (1613): south in live OSRS, north here before.
  assert.equal(facing({ id: 2899 }), Direction.SOUTH);
  assert.equal(facing({ id: 1613 }), Direction.SOUTH);
});

test("an explicit direction keeps its meaning: counted from south-west", () => {
  const expected = [Direction.SOUTH_WEST, Direction.SOUTH, Direction.SOUTH_EAST, Direction.WEST,
    Direction.EAST, Direction.NORTH_WEST, Direction.NORTH, Direction.NORTH_EAST];
  expected.forEach((direction, value) => assert.equal(facing({ id: 1613, direction: value }), direction, `${value}`));
});
