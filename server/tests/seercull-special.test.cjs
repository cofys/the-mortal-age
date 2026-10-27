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
const { FightType } = require('../dist/game/content/combat/FightType');
const { BonusManager } = require('../dist/game/model/equipment/BonusManager');
const { Equipment } = require('../dist/game/model/container/impl/Equipment');
const { ItemIdentifiers: Items } = require('../dist/util/ItemIdentifiers');
const { Misc } = require('../dist/util/Misc');
const { CombatSpecial } = require('../dist/game/content/combat/CombatSpecial');
const { PrayerHandler } = require('../dist/game/content/PrayerHandler');
const { DamageFormulas } = require('../dist/game/content/combat/formula/DamageFormulas');
const { AccuracyFormulasDpsCalc } = require('../dist/game/content/combat/formula/AccuracyFormulasDpsCalc');

before(async () => {
  await CachePipeline.initialize(process.cwd());
  require('../plugins/combat/specials/Seercull.SpecialAttack')({
    core: PluginManager.getCoreApi(), registerCombatSpecial: CombatSpecial.register,
  });
});

function fighter(t, x) {
  const player = new Player(null);
  const sender = new Proxy({}, { get: () => () => sender });
  t.mock.method(player, 'getPacketSender', () => sender);
  player.moveTo(new Location(x, 3525));
  for (const skill of [Skill.RANGED, Skill.HITPOINTS, Skill.PRAYER, Skill.MAGIC]) {
    player.getSkillManager().setMaxLevel(skill, 99);
    player.getSkillManager().setCurrentLevel(skill, 99, false);
  }
  return player;
}

function shot(t, { protection = false, shield = false, roll = 'max', level = 99, ammo = Items.RUNE_ARROW, style = FightType.SHORTBOW_RAPID, offensiveBonuses = false, hp = 99 } = {}) {
  const attacker = fighter(t, 3100), target = fighter(t, 3104);
  attacker.getEquipment().setItem(Equipment.WEAPON_SLOT, new Item(Items.SEERCULL));
  attacker.getEquipment().setItem(Equipment.AMMUNITION_SLOT, new Item(ammo, 100));
  attacker.getSkillManager().setCurrentLevel(Skill.RANGED, level, false);
  attacker.setFightType(style);
  target.setHitpoints(hp);
  if (offensiveBonuses) {
    attacker.setPrayerActive(PrayerHandler.EAGLE_EYE, true);
    attacker.getEquipment().setItem(Equipment.AMULET_SLOT, new Item(Items.NECKLACE_OF_ANGUISH));
    BonusManager.update(attacker);
  }
  attacker.setSpecialActivated(true);
  t.mock.method(attacker, 'getCombatSpecial', () => CombatSpecial.getById('seercull'));
  if (protection) target.setPrayerActive(PrayerHandler.PROTECT_FROM_MISSILES, true);
  if (shield) target.getEquipment().setItem(Equipment.SHIELD_SLOT, new Item(Items.ELYSIAN_SPIRIT_SHIELD));
  t.mock.method(Math, 'random', () => 0); // deterministic Elysian proc
  t.mock.method(Misc, 'randomInclusive', (minimum, maximum) => roll === 'min' ? minimum : maximum);
  // Soulshot must ignore the normal maximum (prayers, Void, armour, Slayer/Salve).
  if (!offensiveBonuses) t.mock.method(DamageFormulas, 'sourceMaxHit', () => 100);
  t.mock.method(AccuracyFormulasDpsCalc, 'rollAccuracy', () => { throw Error('Soulshot must not roll accuracy'); });
  const hit = CombatSpecial.getById('seercull').getCombatMethod().hits(attacker, target)[0];
  return hit;
}

for (const [level, expected] of [[50, 11], [99, 19], [112, 22]]) {
  test(`Soulshot uses visible Ranged ${level} and arrow strength only`, t => {
    assert.equal(shot(t, { level }).getTotalDamage(), expected);
  });
}

test('Soulshot retains PvP protection-prayer reduction', t => {
  assert.equal(shot(t, { protection: true }).getTotalDamage(), 11);
});

test('Soulshot retains Elysian reduction', t => {
  assert.equal(shot(t, { shield: true }).getTotalDamage(), 14);
});

test('Soulshot retains both reductions', t => {
  assert.equal(shot(t, { protection: true, shield: true }).getTotalDamage(), 8);
});

test('Soulshot is accurate even for a zero damage roll', t => {
  const hit = shot(t, { roll: 'min' });
  assert.equal(hit.getTotalDamage(), 0);
  assert.equal(hit.isAccurate(), true);
});

for (const [name, style] of [['Accurate', FightType.SHORTBOW_ACCURATE], ['Rapid', FightType.SHORTBOW_RAPID], ['Longrange', FightType.SHORTBOW_LONGRANGE]]) {
  test(`Soulshot ignores Eagle Eye and anguish in ${name} stance through the real formula`, t => {
    assert.equal(shot(t, { style, offensiveBonuses: true }).getTotalDamage(), 19);
  });
}

test('Soulshot reads the equipped arrow strength (amethyst)', t => {
  assert.equal(shot(t, { ammo: Items.AMETHYST_ARROW }).getTotalDamage(), 20);
});

test('Soulshot stays capped to the target HP at launch', t => {
  assert.equal(shot(t, { hp: 7 }).getTotalDamage(), 7);
});

test('Soulshot drains Magic by its reduced damage and cannot drain an already lowered stat', t => {
  const hit = shot(t, { protection: true });
  const skills = hit.getTarget().getSkillManager();
  const method = hit.getCombatMethod();
  method.handleAfterHitEffects(hit);
  assert.equal(skills.getCurrentLevel(Skill.MAGIC), 88);
  method.handleAfterHitEffects(hit);
  assert.equal(skills.getCurrentLevel(Skill.MAGIC), 88);
  skills.setCurrentLevel(Skill.MAGIC, 99, false);
  method.handleAfterHitEffects(hit);
  assert.equal(skills.getCurrentLevel(Skill.MAGIC), 88);
});

test('Soulshot zero damage leaves Magic intact', t => {
  const hit = shot(t, { roll: 'min' });
  hit.getCombatMethod().handleAfterHitEffects(hit);
  assert.equal(hit.getTarget().getSkillManager().getCurrentLevel(Skill.MAGIC), 99);
});
