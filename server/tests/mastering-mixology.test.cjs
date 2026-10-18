// Run after `yarn build`: node --test tests/mastering-mixology.test.cjs
const assert = require('node:assert/strict');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const Shared = require('../plugins/minigames/mixology/Shared.Mixology');
const Orders = require('../plugins/minigames/mixology/Orders.Mixology');
const Stations = require('../plugins/minigames/mixology/Stations.Mixology');
const Mixer = require('../plugins/minigames/mixology/Mixer.Mixology');

before(() => {
  CachePipeline.initialize();
  Shared.bind({ core: PluginManager.getCoreApi(), emitCustomEvent() {} });
});

/** A player with a Herblore level, an inventory of items and the lab varbits. */
function fakePlayer({ level = 81, items = [], vars = {} } = {}) {
  const attributes = { [Shared.STATE_ATTRIBUTE]: { vars: { ...vars } } };
  const slots = items.map((item) => item ?? null);
  return {
    getAttribute: (key) => attributes[key],
    setAttribute: (key, value) => { attributes[key] = value; },
    getSkillManager: () => ({ getCurrentLevel: () => level, getMaxLevel: () => level }),
    getInventory: () => ({ getItems: () => slots }),
    getPacketSender: () => ({ getVarbit: () => 0, sendVarbit() {} }),
  };
}

function finished(index, modifier, digweed = false) {
  const { Item } = PluginManager.getCoreApi();
  const meta = { [Shared.META.MODIFIER]: modifier };
  if (digweed) meta[Shared.META.DIGWEED] = true;
  return new Item(Shared.potion(index).finished, 1, meta);
}

test('potions come from enum 5542 and their levels from enum 5548', () => {
  assert.equal(Shared.potions().size, 10);
  assert.equal(Shared.potion(1).unfinished, 30011); // mm_potion_mmm_unfinished
  assert.equal(Shared.potion(1).finished, 30021);
  assert.equal(Shared.potion(5).unfinished, 30016); // aam: the index runs aam before aal
  assert.equal(Shared.potion(6).unfinished, 30015);
  assert.equal(Shared.potion(9).name, 'Anti-leech lotion'); // lla
  assert.equal(Shared.potion(9).level, 78);
  assert.equal(Shared.potion(10).level, 81);
});

test('three lever pulls always name a potion', () => {
  assert.equal(Shared.potionFor(Mixer.counts([1, 2, 3])).name, 'Mixalot');
  assert.equal(Shared.potionFor(Mixer.counts([2, 2, 2])).name, 'Alco-augmentator'); // capture: vessel_ready 4
  assert.equal(Shared.potionFor(Mixer.counts([3, 2, 1])).index, 10); // capture: lye after aga, mox -> 10
  assert.equal(Shared.potionFor(Mixer.counts([3, 3, 2])).name, 'Anti-leech lotion');
});

test('a station needs 45 - floor(Herblore / 3) progress', () => {
  // rsprox captures: 21 at 72-74, 20 at 75-77, 19 at 78-80, 12 at 99-100, 11 at 102-103, 8 at 111.
  for (const [level, total] of [[72, 21], [75, 20], [78, 19], [81, 18], [99, 12], [102, 11], [111, 8]]) {
    assert.equal(Stations.total(fakePlayer({ level })), total, `level ${level}`);
  }
});

test('ordered potions pay the Wiki resin and XP; unordered a third and 10 of the best resin', () => {
  const mixalot = Shared.potion(10);
  assert.deepEqual(Orders.rewardOf({ entry: mixalot, ordered: true, digweed: false }), { resin: { mox: 20, aga: 20, lye: 20 }, xp: 365 });
  assert.deepEqual(Orders.rewardOf({ entry: mixalot, ordered: true, digweed: true }), { resin: { mox: 40, aga: 40, lye: 40 }, xp: 730 });
  const mmm = Orders.rewardOf({ entry: Shared.potion(1), ordered: false, digweed: false });
  assert.deepEqual(mmm.resin, { mox: 10, aga: 0, lye: 0 }); // capture 4197: 10/0/0
  assert.equal(Math.floor(mmm.xp), 63); // capture 4197: 63 XP
  assert.deepEqual(Orders.rewardOf({ entry: Shared.potion(2), ordered: false, digweed: false }).resin, { mox: 0, aga: 10, lye: 0 });
});

test('each finished potion fills the first open order with its potion and modifier', () => {
  const vars = {
    [Shared.VARBIT.ORDER_TYPE[0]]: 1, [Shared.VARBIT.ORDER_MODIFIER[0]]: Shared.MODIFIER.ALEMBIC,
    [Shared.VARBIT.ORDER_TYPE[1]]: 4, [Shared.VARBIT.ORDER_MODIFIER[1]]: Shared.MODIFIER.RETORT,
    [Shared.VARBIT.ORDER_TYPE[2]]: 1, [Shared.VARBIT.ORDER_MODIFIER[2]]: Shared.MODIFIER.AGITATOR,
  };
  const player = fakePlayer({
    vars,
    items: [finished(1, Shared.MODIFIER.AGITATOR), finished(4, Shared.MODIFIER.ALEMBIC), finished(1, Shared.MODIFIER.ALEMBIC)],
  });
  const chosen = Orders.choose(player);
  assert.deepEqual(chosen.map((deposit) => deposit.slot), [0, 2]);
  assert.ok(chosen.every((deposit) => deposit.ordered));

  const wrong = fakePlayer({ vars, items: [null, finished(7, Shared.MODIFIER.RETORT), finished(4, Shared.MODIFIER.ALEMBIC)] });
  const unordered = Orders.choose(wrong);
  assert.equal(unordered.length, 1);
  assert.equal(unordered[0].slot, 1);
  assert.equal(unordered[0].ordered, false);
});

test('the resin text over the belt matches the capture', () => {
  assert.equal(Orders.chatterText({ mox: 10, aga: 0, lye: 0 }), '<col=389cff>+10 Mox</col>');
  assert.equal(Orders.chatterText({ mox: 0, aga: 672, lye: 224 }), '   <col=11ff00>+672 Aga</col>   <col=ff242f>+224 Lye</col>');
  assert.equal(Orders.chatterText({ mox: 448, aga: 0, lye: 560 }), '<col=389cff>+448 Mox</col>   <col=ff242f>+560 Lye</col>');
});
