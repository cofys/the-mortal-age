// Run after `yarn build`: node --test tests/gravestones.test.cjs
// Gravestones (docs/gravestones.md): fee bands, how a grave stacks, and which deaths fill one.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");

let core;
let Fees;
let Common;
const hooks = {};
const custom = {};
const spawned = [];
const config = {};

const COINS = 995;
const SHARK = 385;
const RUNE_SCIMITAR = 1333;
const ABYSSAL_WHIP = 4151; // cache value 120,001: the 1,000-coin band
const ARMADYL_GODSWORD = 11802; // 1,250,000: the 10,000-coin band
const IRON_ORE = 440;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  const on = (name) => (handler) => (hooks[name] = handler);
  const api = new Proxy({
    core,
    persistAttribute() {},
    getPluginConfig: (key, fallback) => (key in config ? config[key] : fallback),
    spawnNpc: (definition) => {
      const npc = { definition };
      spawned.push(npc);
      return npc;
    },
    removeNpc: (npc) => spawned.splice(spawned.indexOf(npc), 1),
    onCustomEvent: (name, handler) => (custom[name] = handler),
    emitCustomEvent: (name, payload) => custom[name]?.(payload),
    onInterfaceActionButton() {},
  }, { get: (target, key) => (key in target ? target[key] : on(String(key))) });
  require("../plugins/world/Gravestones.plugin").register(api);
  Fees = require("../plugins/world/gravestones/Fees.Gravestones");
  Common = require("../plugins/world/gravestones/Common.Gravestones");
});

/** A real player whose messages and varbits are recorded; `mode` is its ironman mode. */
function account(name, mode = null) {
  const player = new Player(null);
  player.setUsername(name);
  const messages = [];
  const varbits = new Map();
  const sender = new Proxy({}, {
    get: (target, key) => {
      if (key === "sendVarbit") return (id, value) => (varbits.set(id, value), sender);
      if (key === "getVarbit") return (id) => varbits.get(id) ?? 0;
      if (key === "isSubInterfaceOpen") return () => false;
      return () => sender;
    },
  });
  player.getPacketSender = () => sender;
  player.sendMessage = (text) => messages.push(text);
  custom["ironman:mode"] = (query) => (query.mode = query.player === player ? mode : query.mode);
  return Object.assign(player, { messages, varbits });
}

function death(player, items, { killer = null, x = 3222, y = 3218 } = {}) {
  const event = {
    player,
    killer,
    location: new core.Location(x, y, 0),
    items: items.filter(([id]) => core.ItemDefinition.forId(id).isTradeable()).map(([id, amount]) => new core.Item(id, amount)),
    untradeables: items.filter(([id]) => !core.ItemDefinition.forId(id).isTradeable()).map(([id, amount]) => new core.Item(id, amount)),
    layout: { inventory: items.map(([id]) => id), equipment: [] },
  };
  hooks.onPlayerDeathDrops(event);
  return event;
}

const graveOf = (player) => player.getAttribute("gravestones:grave");

test('an encounter grave discount survives persistence and does not discount the Office', t => {
  const Grave = require('../plugins/world/gravestones/Grave.Gravestones');
  const player = account('discounted');
  custom['gravestones:grave-location'] = request => {
    request.tile = { x: 3220, y: 3218, z: 0 };
    request.feeMultiplier = 0.25;
  };
  t.after(() => { delete custom['gravestones:grave-location']; });
  death(player, [[ABYSSAL_WHIP, 1]]);
  assert.equal(graveOf(player).feeMultiplier, 0.25);
  player.setAttribute('gravestones:grave', JSON.parse(JSON.stringify(graveOf(player))));
  assert.equal(Grave.fee(player), 250);
  assert.equal(Fees.officeFee(ABYSSAL_WHIP, false), 6000, 'Office valuation is unchanged');
});

test('invalid encounter discounts retain normal fees and merged graves cannot launder fees', t => {
  const Grave = require('../plugins/world/gravestones/Grave.Gravestones');
  t.after(() => { delete custom['gravestones:grave-location']; });
  for (const multiplier of [-1, 2, NaN, '0.25']) {
    const player = account(`invalid-${String(multiplier)}`);
    custom['gravestones:grave-location'] = request => { request.feeMultiplier = multiplier; };
    death(player, [[ABYSSAL_WHIP, 1]]);
    assert.equal(Grave.fee(player), 1000);
  }
  const player = account('merged-discounts');
  custom['gravestones:grave-location'] = request => { request.feeMultiplier = 0.25; };
  death(player, [[ABYSSAL_WHIP, 1]]);
  delete custom['gravestones:grave-location'];
  death(player, [[ARMADYL_GODSWORD, 1]]);
  assert.equal(Grave.fee(player), 11000, 'normal-fee items cannot enter a discounted grave');
  custom['gravestones:grave-location'] = request => { request.feeMultiplier = 0.25; };
  death(player, [[ABYSSAL_WHIP, 1]]);
  assert.equal(Grave.fee(player), 12000, 'a later discounted death cannot discount the existing contents');
});

test("grave fees: free under 100k, then 1k, 10k or 100k each, 500k at most; ironmen pay half", () => {
  const records = [{ id: ABYSSAL_WHIP, amount: 1 }, { id: ARMADYL_GODSWORD, amount: 1 }, { id: RUNE_SCIMITAR, amount: 1 }];
  assert.equal(Fees.graveFee(records, false), 11000);
  assert.equal(Fees.graveFee(records, true), 5500);
  assert.equal(Fees.graveFee([{ id: ARMADYL_GODSWORD, amount: 80 }], false), 500000);
  assert.equal(Fees.graveFee([{ id: RUNE_SCIMITAR, amount: 5 }], false), 0);
});

test("the fee threshold varbits point one past the first slot below each band", () => {
  const sorted = Common.stack([], [{ id: RUNE_SCIMITAR, amount: 1 }, { id: ABYSSAL_WHIP, amount: 1 }, { id: ARMADYL_GODSWORD, amount: 1 }], 120).held;
  assert.deepEqual(sorted.map(({ id }) => id), [ARMADYL_GODSWORD, ABYSSAL_WHIP, RUNE_SCIMITAR], "most valuable first");
  assert.equal(Fees.threshold(sorted, 100000), 3);
  assert.equal(Fees.threshold(sorted, 1000000), 2);
  assert.equal(Fees.threshold(sorted, 10000000), 1);
  assert.equal(Fees.threshold([{ id: ARMADYL_GODSWORD, amount: 1 }], 100000), 0, "0 when no slot is below");
});

test("Death's Office charges 5% of items worth 100k or more", () => {
  assert.equal(Fees.officeFee(ARMADYL_GODSWORD, false), 62500);
  assert.equal(Fees.officeFee(ARMADYL_GODSWORD, true), 31250);
  assert.equal(Fees.officeFee(RUNE_SCIMITAR, false), 0);
});

test("a grave stacks like a bank, caps a stack at 2^31-1 and returns what doesn't fit", () => {
  const { held, overflow } = Common.stack([{ id: COINS, amount: 2147483000, meta: null }], [{ id: COINS, amount: 1000, meta: null }], 120);
  assert.deepEqual(held, [{ id: COINS, amount: 2147483647, meta: null }]);
  assert.deepEqual(overflow, [{ id: COINS, amount: 353, meta: null }]);
  const full = Common.stack([], [{ id: ABYSSAL_WHIP, amount: 1 }, { id: RUNE_SCIMITAR, amount: 1 }], 1);
  assert.deepEqual([full.held.map(({ id }) => id), full.overflow.map(({ id }) => id)], [[ABYSSAL_WHIP], [RUNE_SCIMITAR]]);
});

test("a PvM death fills a grave, food and potions form a supply pile", () => {
  const player = account("grave1");
  const event = death(player, [[ABYSSAL_WHIP, 1], [SHARK, 2], [COINS, 500]]);
  assert.deepEqual(event.items.map((item) => item.getId()), [SHARK], "the sharks still fall to the floor");
  assert.deepEqual(graveOf(player).items.map(({ id }) => id), [ABYSSAL_WHIP, COINS]);
  assert.equal(graveOf(player).duration, 1500);
  assert.deepEqual(player.messages, ["Some supplies have been dropped where you died."]);
  assert.equal(spawned.at(-1).definition.ownerOnly, true);
});

test("with supply piles off, food goes in the grave too", () => {
  const player = account("grave2");
  player.varbits.set(Common.VARBIT.supplyPilesDisabled, 1);
  const event = death(player, [[SHARK, 2]]);
  assert.equal(event.items.length, 0);
  assert.deepEqual(graveOf(player).items, [{ id: SHARK, amount: 2, meta: null }]);
});

test("PvP deaths, Ultimate Ironmen and a world without graves leave the items to drop", () => {
  const killed = account("grave3");
  const pvp = death(killed, [[ABYSSAL_WHIP, 1]], { killer: account("killer") });
  assert.equal(pvp.items.length, 1);
  assert.equal(graveOf(killed), undefined);
  const uim = account("grave4", "ultimate");
  assert.equal(death(uim, [[ABYSSAL_WHIP, 1]]).items.length, 1);
  config["Gravestones:enabled"] = false;
  const off = account("grave5");
  assert.equal(death(off, [[ABYSSAL_WHIP, 1]]).items.length, 1);
  delete config["Gravestones:enabled"];
});

test("a second death adds to the grave and sends its resources to Death's Office", () => {
  const player = account("grave6");
  death(player, [[ABYSSAL_WHIP, 1], [IRON_ORE, 5]]);
  death(player, [[RUNE_SCIMITAR, 1]]);
  assert.deepEqual(graveOf(player).items.map(({ id }) => id), [ABYSSAL_WHIP, RUNE_SCIMITAR]);
  assert.equal(graveOf(player).merged, true);
  assert.deepEqual(player.getAttribute("gravestones:office"), [{ id: IRON_ORE, amount: 5, meta: null }]);
  assert.ok(player.messages.includes("Some items have been moved to Death's Office from your gravestone."));
});
