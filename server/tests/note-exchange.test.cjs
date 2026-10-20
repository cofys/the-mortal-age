// Run after `yarn build`: node --test tests/note-exchange.test.cjs
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { PluginManager } = require("../dist/plugins/PluginManager");
const NoteExchange = require("../plugins/npcs/NoteExchange.plugin");
const DATA = require("../plugins/npcs/data/note-exchange.json");
const { exchangeable, accepts } = NoteExchange._test;

const core = PluginManager.getCoreApi();
const COINS = 995;
const BONES = 526;
const BONES_NOTE = 527;
const LOGS = 1511;
const phials = { fee: 5 };

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  NoteExchange.register({ core, onItemOnNpc: () => {} });
});

/** Stacks of [id, amount], one per slot; the rest of the 28 slots are free. */
function playerWith(stacks) {
  return {
    getInventory: () => ({
      getAmount: (id) => stacks.filter(([itemId]) => itemId === id).reduce((sum, [, amount]) => sum + amount, 0),
      getFreeSlots: () => 28 - stacks.length,
    }),
  };
}

const filler = (count) => Array.from({ length: count }, () => [LOGS, 1]);

test("the data: every merchant is the NPC it names, and every accepted item exists", () => {
  const names = new Set();
  for (let id = 0; id < CacheDefinitions.getCounts().items; id++) names.add(CacheDefinitions.getItem(id).name);
  for (const merchant of DATA.merchants) {
    const id = core.NpcIdentifiers[merchant.npc];
    assert.ok(Number.isInteger(id), merchant.npc);
    assert.equal(CacheDefinitions.getNpc(id).name, merchant.name);
    for (const item of Array.isArray(merchant.accepts) ? merchant.accepts : []) assert.ok(names.has(item), item);
  }
});

test("capped by notes held, coins and free slots", () => {
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 30], [COINS, 1000]]), phials, BONES_NOTE, BONES, 30), 26);
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 30], [COINS, 100]]), phials, BONES_NOTE, BONES, 30), 20);
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 3], [COINS, 1000]]), phials, BONES_NOTE, BONES, 10), 3);
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 30], [COINS, 4]]), phials, BONES_NOTE, BONES, 1), 0);
});

test("a stack used up in full frees its slot", () => {
  // Full inventory: the last note and the last 5 coins each give back a slot.
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 1], [COINS, 1000], ...filler(26)]), phials, BONES_NOTE, BONES, 1), 1);
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 2], [COINS, 10], ...filler(26)]), phials, BONES_NOTE, BONES, 2), 2);
  assert.equal(exchangeable(playerWith([[BONES_NOTE, 5], [COINS, 1000], ...filler(26)]), phials, BONES_NOTE, BONES, 5), 0);
});

test("bones-only merchants", () => {
  const druid = { accepts: "bury" };
  assert.equal(accepts(druid, BONES), true);
  assert.equal(accepts(druid, LOGS), false);
  const virilis = { accepts: new Set(["Bones"]) };
  assert.equal(accepts(virilis, BONES), true);
  assert.equal(accepts(virilis, LOGS), false);
  assert.equal(accepts({}, LOGS), true);
});
