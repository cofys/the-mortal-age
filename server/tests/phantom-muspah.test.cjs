// node --test tests/phantom-muspah.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const Common = require("../plugins/bosses/phantommuspah/Common.PhantomMuspah");

const ITEMS = { FROZEN_CACHE: 27622, ANCIENT_ICON: 27627, VENATOR_SHARD: 27614, ANCIENT_ESSENCE: 27616, CHARGED_ICE: 27643 };
const hooks = { custom: {} };
const fakeApi = {
  core: { ItemIdentifiers: new Proxy(ITEMS, { get: (items, name) => items[name] ?? 1000 + String(name).length }) },
  persistAttribute() {},
  onPlayerLogin() {},
  onNpcDeath() {},
  onItemAction() {},
  onCustomEvent(name, handler) {
    (hooks.custom[name] ??= []).push(handler);
  },
  emitCustomEvent(name, payload) {
    for (const handler of hooks.custom[name] ?? []) handler(payload);
  },
};
Common.init(fakeApi);

const Loot = require("../plugins/bosses/phantommuspah/Loot.PhantomMuspah");
const { SpikeField } = require("../plugins/bosses/phantommuspah/Spikes.PhantomMuspah");
Loot.attachLoot(fakeApi);

const key = ([x, y]) => `${x},${y}`;

test("the arena is every tile a captured shockwave reached, plus the centre", () => {
  const { tiles, kind } = Common.arena();
  assert.equal(kind.size, 433);
  assert.ok(Common.onArena(Common.data.boss.centre));
  assert.ok(tiles.length >= kind.size);
  // The open floor (the lair's collision adds nothing past what the shockwaves covered).
  assert.ok(Common.onArena([2858, 4265]));
  assert.ok(Common.onArena([2838, 4255]));
});

test("every teleport and shockwave tile puts the Muspah's centre on the arena", () => {
  for (const [x, y] of [...Common.data.clouds.loop, Common.data.shockwave.tile, Common.data.boss.tile]) {
    assert.ok(Common.onArena([x + 2, y + 2]), `${x},${y}`);
  }
  assert.deepEqual(Common.data.shockwave.tile.slice(0, 2).map((value, i) => value + 2), Common.data.boss.centre);
});

test("lair tiles map into the instance and back", () => {
  const area = {
    getBaseX: () => 6400, getBaseY: () => 1600,
    tile: (x, y, z) => ({ getX: () => 6400 + x, getY: () => 1600 + y, getZ: () => z }),
  };
  const at = Common.tileIn(area, [2859, 4259, 0]);
  assert.deepEqual([at.getX(), at.getY()], [6400 + 43, 1600 + 35]);
  assert.deepEqual(Common.lairTile(area, at), [2859, 4259, 0]);
});

test("fight durations print as m:ss.SS, as captured", () => {
  assert.equal(Loot.formatTicks(108), "1:04.80");
  assert.equal(Loot.formatTicks(32), "0:19.20");
  assert.equal(Loot.formatTicks(311), "3:06.60");
});

test("the frozen cache gives one of its Wiki rewards", () => {
  const essence = Common.data.frozenCache.entries.find((entry) => entry.essence).essence;
  for (let i = 0; i < 2000; i++) {
    const reward = Loot.rollCache();
    assert.ok(Number.isInteger(reward.itemId) && reward.amount >= 1);
    if (reward.itemId !== ITEMS.ANCIENT_ESSENCE) continue;
    assert.ok(essence.some(([min, max, step]) => reward.amount >= min && reward.amount <= max && (reward.amount - min) % step === 0));
  }
});

function fakePlayer({ ownsIce = false } = {}) {
  const messages = [];
  return {
    messages,
    sendMessage: (text) => messages.push(text),
    getInventory: () => ({ getAmount: (id) => (ownsIce && id === ITEMS.CHARGED_ICE ? 1 : 0) }),
    getBanks: () => [],
  };
}

test("a kill under 3:00 adds Charged ice, unless the player has one", () => {
  const roll = (player, lootTicks) => {
    const event = { npc: { __muspahFight: { lootTicks } }, player, drops: [] };
    fakeApi.emitCustomEvent("npc-drops:roll", event);
    return event.drops.map((drop) => drop.itemId);
  };
  const quick = fakePlayer();
  assert.deepEqual(roll(quick, 299), [ITEMS.CHARGED_ICE]);
  assert.match(quick.messages[0], /Untradeable drop: Charged ice/);
  assert.deepEqual(roll(fakePlayer(), 300), []);
  assert.deepEqual(roll(fakePlayer({ ownsIce: true }), 100), []);
});

test("a Venator shard comes without the main table's loot", () => {
  const event = {
    npc: { __muspahFight: { lootTicks: 999 } },
    player: fakePlayer(),
    drops: [
      { itemId: ITEMS.VENATOR_SHARD, amount: 1 },
      { itemId: 1201, amount: 3, noted: true }, // Rune kiteshield, main table
      { itemId: ITEMS.ANCIENT_ESSENCE, amount: 560 }, // separate roll
      { itemId: 2722, amount: 1 }, // hard clue, tertiary
    ],
  };
  fakeApi.emitCustomEvent("npc-drops:roll", event);
  assert.deepEqual(event.drops.map((drop) => drop.itemId), [ITEMS.VENATOR_SHARD, ITEMS.ANCIENT_ESSENCE, 2722]);
});

test("a spike shelters the tiles behind it from the centre, not those beside it", () => {
  const field = Object.create(SpikeField.prototype);
  field.spikes = new Map([[key([2845, 4263]), {}], [key([2846, 4263]), {}]]);
  const centre = Common.data.boss.centre;
  // Captured: (2845, 4267) behind the pair took no shockwave; (2848, 4264) beside it did.
  assert.equal(field.shelters(centre, [2845, 4267]), true);
  assert.equal(field.shelters(centre, [2844, 4266]), true);
  assert.equal(field.shelters(centre, [2848, 4264]), false);
  assert.equal(field.shelters(centre, [2838, 4258]), false);
});

test("corruption drains 3, 6 and 9 prayer at 11, 21 and 31 ticks, as captured", () => {
  const tasks = [];
  const core = fakeApi.core;
  core.Task = class {
    constructor(delay) { this.delay = delay; }
    stop() { this.stopped = true; }
  };
  core.TaskManager = { submit: (task) => tasks.push({ task, at: now + task.delay }) };
  core.Skill = { PRAYER: "prayer" };
  let now = 0;
  let prayer = 99;
  const varbits = {};
  const events = [];
  const player = {
    isRegistered: () => true,
    sendMessage: (text) => events.push([now, text]),
    getPacketSender: () => ({ sendVarbit: (id, value) => { varbits[id] = value; } }),
    getSkillManager: () => ({
      getCurrentLevel: () => prayer,
      setCurrentLevel: (_skill, level) => { prayer = level; },
    }),
    showHitsplat: (amount) => events.push([now, `drain ${amount}`]),
  };
  const Corruption = require("../plugins/bosses/phantommuspah/Corruption.PhantomMuspah");
  Corruption.corrupt(player, 3);
  assert.deepEqual([varbits[12142], varbits[12141], varbits[12140]], [3, 1, 3]);
  for (now = 1; now <= 40; now++) {
    for (const entry of tasks.filter((t) => t.at === now)) entry.task.execute();
  }
  assert.deepEqual(events.filter(([, text]) => text.startsWith("drain")), [[11, "drain 3"], [21, "drain 6"], [31, "drain 9"]]);
  assert.equal(prayer, 99 - 18);
  assert.equal(events.at(-2)[1], Common.data.corruption.end);
  assert.deepEqual([varbits[12142], varbits[12141], varbits[12140]], [0, 0, 0]);
});

test("the Muspah's attackable forms hold a freeze for 66% of its base duration", () => {
  fakeApi.core.CombatMethod = class {};
  fakeApi.core.CombatType = { RANGED: 0 };
  fakeApi.registerNpcCombatMethodProvider = () => {};
  fakeApi.onNpcHitModify = () => {};
  fakeApi.onNpcBeforeDeath = () => {};
  const Fight = require("../plugins/bosses/phantommuspah/Fight.PhantomMuspah");
  Fight.attachFight(fakeApi);
  for (const form of ["ranged", "melee", "shielded", "final"]) {
    const freeze = { target: { getId: () => Common.data.npcs[form] }, ticks: 20 };
    fakeApi.emitCustomEvent("combat:freeze-duration", freeze);
    assert.equal(freeze.ticks, 20 * 0.66, form);
  }
  const teleport = { target: { getId: () => Common.data.npcs.teleport }, ticks: 20 };
  fakeApi.emitCustomEvent("combat:freeze-duration", teleport);
  assert.equal(teleport.ticks, 20);
});
