const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const H = require('./helpers/leviathan.cjs');
before(H.initialize);

function shot(h, ammo, type = h.core.CombatType.RANGED, damage = 1) {
  h.p.setNeedsPlacement(false); h.fight.boss.setNeedsPlacement(false);
  h.p.getCombat().setAmmunition(ammo);
  const method = new (class extends h.core.CombatMethod { type() { return type; } })();
  const hit = new h.core.PendingHit(h.p, h.fight.boss, method,
    { damage, rollAccuracy: false, experience: false, handleAfterHitEffects: false });
  h.core.CombatFactory.addPendingHit(hit);
}
function completed(h) {
  return h.emitted.some(([name, event]) => name === 'combat-achievements:complete' && event.task === 'Unconventional');
}
function finish(h) {
  require('../plugins/bosses/leviathan/Rewards.Leviathan').attach(h.api);
  h.kill(); h.step(8);
}

for (const name of ['MITHRIL_ARROW', 'MITHRIL_BOLT', 'ENCHANTED_EMERALD_BOLT', 'MITHRIL_DART', 'MITHRIL_JAVELIN', 'MITHRIL_KNIFE', 'MITHRIL_THROWNAXE'])
  test(`Unconventional permits actual ${name} ammunition`, t => {
    const h = H.harness(t, false, 25);
    shot(h, h.core.Ammunition[name]);
    finish(h);
    assert.equal(completed(h), true);
  });

test('Unconventional observes seeking mithril arrows and the loaded shot, not an equipment swap', t => {
  const h = H.harness(t, false, 25);
  const id = h.core.ItemIdentifiers.SEEKING_MITHRIL_ARROW;
  assert.ok(id > 0);
  shot(h, { getItemId: () => id });
  h.p.getCombat().setAmmunition(h.core.Ammunition.RUNE_ARROW);
  finish(h);
  assert.equal(completed(h), true);
});

for (const start of [25, 26]) test(`Unconventional rejects HP above25, including same-tick transient healing (start${start})`, t => {
  const h = H.harness(t, false, start);
  h.p.setHitpoints(25);
  if (start === 25) { h.p.heal(1); h.p.setHitpoints(25); }
  shot(h, h.core.Ammunition.MITHRIL_ARROW);
  finish(h);
  assert.equal(completed(h), false);
});

test('Unconventional allows healing up to25 and freezes at lethal damage before post-fight regeneration', t => {
  const h = H.harness(t, false, 20);
  h.p.heal(5);
  shot(h, h.core.Ammunition.MITHRIL_ARROW);
  require('../plugins/bosses/leviathan/Rewards.Leviathan').attach(h.api);
  h.kill(); h.p.heal(20); h.step(8);
  assert.equal(completed(h), true);
});

test('Unconventional rejects a wrong zero-damage ranged shot even when equipment is subsequently changed', t => {
  const h = H.harness(t, false, 25);
  shot(h, h.core.Ammunition.RUNE_ARROW, h.core.CombatType.RANGED, 0);
  h.p.getCombat().setAmmunition(h.core.Ammunition.MITHRIL_ARROW);
  finish(h);
  assert.equal(completed(h), false);
});

test('Unconventional permits shadow stuns but rejects other offensive spells', t => {
  const h = H.harness(t, false, 25);
  const shadow = h.core.CombatSpells.SHADOW_RUSH.getSpell();
  h.p.getCombat().setCastSpell(shadow);
  shot(h, null, h.core.CombatType.MAGIC);
  shot(h, h.core.Ammunition.MITHRIL_ARROW);
  finish(h);
  assert.equal(completed(h), true);
});

test('Unconventional rejects non-shadow magic and fights with no mithril shot', t => {
  const h = H.harness(t, false, 25);
  shot(h, null, h.core.CombatType.MAGIC);
  finish(h);
  assert.equal(completed(h), false);
});

for (const weapon of ['ROSEWOOD_BLOWPIPE', 'IRONWOOD_BLOWPIPE', 'CAMPHOR_BLOWPIPE'])
  test(`Unconventional preserves documented ${weapon} exception with mithril darts`, t => {
    const h = H.harness(t, false, 25);
    h.p.getEquipment().set(h.core.Equipment.WEAPON_SLOT, new h.core.Item(h.core.ItemIdentifiers[weapon]));
    shot(h, h.core.Ammunition.MITHRIL_DART);
    finish(h);
    assert.equal(completed(h), false);
  });

test('Unconventional resolves toxic blowpipe loaded darts while ignoring the ammo slot', t => {
  const h = H.harness(t, false, 25);
  let resolver;
  const api = new Proxy({ core: h.core, registerRangedAmmoResolver(value) { resolver = value; } },
    { get: (api, name) => api[name] ?? (() => {}) });
  require('../plugins/items/ToxicBlowpipe.plugin').register(api);
  const pipe = new h.core.Item(h.core.ItemIdentifiers.TOXIC_BLOWPIPE);
  pipe.setMetaValue('toxic-blowpipe', { dartId: h.core.ItemIdentifiers.MITHRIL_DART, dartAmount: 5, scales: 50 });
  h.p.getEquipment().set(h.core.Equipment.WEAPON_SLOT, pipe);
  h.p.getEquipment().set(h.core.Equipment.AMMUNITION_SLOT, new h.core.Item(h.core.ItemIdentifiers.RUNE_ARROW, 50));
  shot(h, resolver.resolve(h.p));
  finish(h);
  assert.equal(completed(h), true);
});

test('Unconventional allows thrall damage and does not count a carried mithril item as a shot', t => {
  const h = H.harness(t, false, 25);
  h.p.getInventory().add(new h.core.Item(h.core.ItemIdentifiers.MITHRIL_ARROW, 50), false);
  h.fight.boss.setNeedsPlacement(false);
  // ArceuusThralls uses this direct-damage queue and attributes the kill to its owner.
  h.fight.boss.getCombat().getHitQueue().addPendingDamage([new h.core.HitDamage(3, h.core.HitMask.RED)]);
  h.fight.boss.getCombat().addDamage(h.p, 3);
  h.step();
  assert.equal(h.fight.unconventional.eligible, true);
  assert.equal(h.fight.unconventional.fired, false);
  shot(h, h.core.Ammunition.MITHRIL_ARROW);
  finish(h);
  assert.equal(completed(h), true);
});

test('a second fight resets its restriction state and a stopped fight cannot award the task', t => {
  const h = H.harness(t, false, 25);
  shot(h, h.core.Ammunition.RUNE_ARROW);
  h.fight.stop();
  h.fight = new (require('../plugins/bosses/leviathan/Fight.Leviathan').Fight)(h.session);
  h.session.fight = h.fight; h.fight.start();
  shot(h, h.core.Ammunition.MITHRIL_ARROW);
  require('../plugins/bosses/leviathan/Rewards.Leviathan').attach(h.api);
  h.fight.boss.getCombat().addDamage(h.p, 1);
  h.fight.boss.setHitpoints(0);
  h.step(8);
  assert.equal(completed(h), true);
});
