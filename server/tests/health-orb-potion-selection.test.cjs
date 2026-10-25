const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const Potions = require('../plugins/items/Potions.plugin');
let core;
before(async () => {
  await CachePipeline.initialize(process.cwd()); core = PluginManager.getCoreApi();
  Potions.register(new Proxy({ core }, { get: (object, key) => object[key] ?? (() => {}) }));
});
function fixture(t, keys, venom = false) {
  const p = new Player(null), changes = [], messages = [];
  p.setPoisonDamage(venom ? 12 : 30); p.setVenomed(venom); p.setRunEnergy(50);
  const sender = new Proxy({}, { get: () => () => sender });
  t.mock.method(p, 'getPacketSender', () => sender);
  t.mock.method(p, 'sendMessage', message => messages.push(message));
  keys.forEach((key, slot) => p.getInventory().setItem(slot, new core.Item(core.ItemIdentifiers[key], 1)));
  const setItem = p.getInventory().setItem.bind(p.getInventory());
  t.mock.method(p.getInventory(), 'setItem', (slot, item) => { changes.push({ slot, id: item.getId() }); return setItem(slot, item); });
  return { p, changes, messages, cure() { Potions._test.cureFromHealthOrb({ player: p }); } };
}
const strengths = ['ANTIPOISON_1_', 'SUPERANTIPOISON_1_', 'ANTIDOTE_1_', 'ANTIDOTE_1__3', 'ANTI_VENOM_1_', 'ANTI_VENOM_1__3'];
test('a later stronger potion wins over an earlier weaker one for poison and venom', t => {
  for (const venom of [false, true]) for (let weak = 0; weak < strengths.length; weak++) {
    for (let strong = weak + 1; strong < strengths.length; strong++) {
      const f = fixture(t, [strengths[weak], strengths[strong]], venom); f.cure();
      assert.equal(f.changes.length, 1);
      assert.equal(f.changes[0].slot, 1, `${strengths[strong]} over ${strengths[weak]}`);
      const reversed = fixture(t, [strengths[strong], strengths[weak]], venom); reversed.cure();
      assert.equal(reversed.changes[0].slot, 0);
    }
  }
});
test('the least remaining dose is used within the chosen potion family', t => {
  for (const stem of ['ANTIPOISON_', 'SUPERANTIPOISON_', 'SANFEW_SERUM_', 'GUTHIX_REST_']) {
    const f = fixture(t, [`${stem}4_`, `${stem}2_`, `${stem}1_`, `${stem}3_`]); f.cure();
    assert.deepEqual(f.changes, [{ slot: 2, id: Potions._test.findPotionEntry(core.ItemIdentifiers[`${stem}1_`]).replacementId }]);
  }
});
test('equal doses of the chosen family use the first inventory slot', t => {
  const f = fixture(t, ['ENERGY_POTION_1_', 'ANTIPOISON_2_', 'ANTIPOISON_2_']); f.cure();
  assert.equal(f.changes.length, 1); assert.equal(f.changes[0].slot, 1);
});
test('potion strength precedes dose count', t => {
  const f = fixture(t, ['ANTIPOISON_1_', 'ANTI_VENOM_4__3', 'ANTI_VENOM_2__3']); f.cure();
  assert.equal(f.changes[0].slot, 2);
});
test('Guthix rest can be selected alone but a full antipoison takes precedence', t => {
  const alone = fixture(t, ['GUTHIX_REST_4_']); alone.cure();
  assert.deepEqual(alone.changes, [{ slot: 0, id: core.ItemIdentifiers.GUTHIX_REST_3_ }]);
  const mixed = fixture(t, ['GUTHIX_REST_1_', 'ANTIPOISON_4_']); mixed.cure();
  assert.equal(mixed.changes[0].slot, 1);
});
test('barbarian mixes retain their treatment strength and least-dose selection', t => {
  const f = fixture(t, ['ANTIPOISON_1_', 'ANTIDOTE_MIX_2_', 'ANTIDOTE_MIX_1_']); f.cure();
  assert.equal(f.changes[0].slot, 2);
});

test('extended anti-venom and supermix join the ordinary orb dose-selection rules', t => {
  const extended = fixture(t, ['ANTI_VENOM_1__3', 'EXTENDED_ANTI_VENOM_4_', 'EXTENDED_ANTI_VENOM_1_'], true);
  extended.cure(); assert.equal(extended.changes[0].slot, 2);
  const mix = fixture(t, ['ANTIPOISON_1_', 'ANTI_POISON_SUPERMIX_2_', 'ANTI_POISON_SUPERMIX_1_']);
  mix.cure(); assert.equal(mix.changes[0].slot, 2);
});
test('different equal-strength potion families retain their existing inventory precedence', t => {
  for (const keys of [['SANFEW_SERUM_4_', 'SUPERANTIPOISON_1_', 'SANFEW_SERUM_2_'],
    ['SUPERANTIPOISON_4_', 'SANFEW_SERUM_1_', 'SUPERANTIPOISON_2_']]) {
    const f = fixture(t, keys); f.cure();
    assert.equal(f.changes[0].slot, 2);
  }
});
test('unrelated and noted items are ignored, and potion cooldowns still block consumption', t => {
  assert.equal(core.ItemDefinition.forId(core.ItemIdentifiers.ANTIPOISON_4__2).isNoted(), true);
  const f = fixture(t, ['ANTIPOISON_4__2', 'ENERGY_POTION_4_', 'ANTIPOISON_3_']); f.cure();
  assert.equal(f.changes[0].slot, 2);
  const blocked = fixture(t, ['ANTI_VENOM_4__3']);
  blocked.p.getTimers().extendOrRegister(core.TimerKey.POTION, 3); blocked.cure();
  assert.deepEqual(blocked.changes, []);
});
