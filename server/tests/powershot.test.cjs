const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { Item } = require('../dist/game/model/Item');
const { Location } = require('../dist/game/model/Location');
const { Skill } = require('../dist/game/model/Skill');
const { Equipment } = require('../dist/game/model/container/impl/Equipment');
const { ItemIdentifiers: Items } = require('../dist/util/ItemIdentifiers');
const { Misc } = require('../dist/util/Misc');
const { CombatSpecial } = require('../dist/game/content/combat/CombatSpecial');
const { PrayerHandler } = require('../dist/game/content/PrayerHandler');
const { DamageFormulas } = require('../dist/game/content/combat/formula/DamageFormulas');
const { AccuracyFormulasDpsCalc } = require('../dist/game/content/combat/formula/AccuracyFormulasDpsCalc');

before(async () => {
  await CachePipeline.initialize(process.cwd());
  require('../plugins/combat/specials/MagicLongbow.SpecialAttack')({
    core: PluginManager.getCoreApi(), registerCombatSpecial: CombatSpecial.register,
  });
});

function fighter(t, x) {
  const player = new Player(null);
  const sender = new Proxy({}, { get: () => () => sender });
  t.mock.method(player, 'getPacketSender', () => sender);
  player.moveTo(new Location(x, 3525));
  for (const skill of [Skill.RANGED, Skill.HITPOINTS, Skill.PRAYER]) {
    player.getSkillManager().setMaxLevel(skill, 99);
    player.getSkillManager().setCurrentLevel(skill, 99, false);
  }
  return player;
}

function shot(t, { weapon = Items.MAGIC_LONGBOW, protection = false, shield = false, roll = 'max', level = 99 } = {}) {
  const attacker = fighter(t, 3100), target = fighter(t, 3104);
  attacker.getEquipment().setItem(Equipment.WEAPON_SLOT, new Item(weapon));
  attacker.getEquipment().setItem(Equipment.AMMUNITION_SLOT, new Item(Items.RUNE_ARROW, 100));
  attacker.getSkillManager().setCurrentLevel(Skill.RANGED, level, false);
  attacker.setSpecialActivated(true);
  t.mock.method(attacker, 'getCombatSpecial', () => CombatSpecial.getById('magic_longbow'));
  if (protection) target.setPrayerActive(PrayerHandler.PROTECT_FROM_MISSILES, true);
  if (shield) target.getEquipment().setItem(Equipment.SHIELD_SLOT, new Item(Items.ELYSIAN_SPIRIT_SHIELD));
  t.mock.method(Math, 'random', () => 0); // deterministic Elysian proc
  t.mock.method(Misc, 'randomInclusive', (minimum, maximum) => roll === 'min' ? minimum : maximum);
  // Powershot must ignore the normal maximum (prayers, Void, armour, Slayer/Salve).
  t.mock.method(DamageFormulas, 'sourceMaxHit', () => 100);
  t.mock.method(AccuracyFormulasDpsCalc, 'rollAccuracy', () => { throw Error('Powershot must not roll accuracy'); });
  const hit = CombatSpecial.getById('magic_longbow').getCombatMethod().hits(attacker, target)[0];
  return hit;
}

for (const weapon of [Items.MAGIC_LONGBOW, Items.MAGIC_COMP_BOW]) {
  test(`Powershot (${weapon}) retains 40% PvP protection-prayer reduction`, t => {
    const hit = shot(t, { weapon, protection: true });
    // Rune arrows have +49 strength: floor(0.5 + 109 * 113 / 640) = 19.
    assert.equal(hit.getTotalDamage(), 11);
    assert.equal(hit.isAccurate(), true);
  });

  test(`Powershot (${weapon}) retains Elysian damage reduction`, t => {
    assert.equal(shot(t, { weapon, shield: true }).getTotalDamage(), 14);
  });
}

test('Powershot retains prayer and Elysian reductions together', t => {
  assert.equal(shot(t, { protection: true, shield: true }).getTotalDamage(), 8);
});

test('Powershot uses only visible level and arrow strength, ignoring the normal max hit', t => {
  assert.equal(shot(t, { level: 112 }).getTotalDamage(), 22);
});

test('Powershot remains guaranteed accurate even when its damage roll is zero', t => {
  const hit = shot(t, { protection: true, roll: 'min' });
  assert.equal(hit.getTotalDamage(), 0);
  assert.equal(hit.isAccurate(), true);
});
