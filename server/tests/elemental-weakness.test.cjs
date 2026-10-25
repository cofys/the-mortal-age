const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
const { NpcDefinition } = require('../dist/game/definition/NpcDefinition');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { NPC } = require('../dist/game/entity/impl/npc/NPC');
const { DamageFormulas: Damage } = require('../dist/game/content/combat/formula/DamageFormulas');
const { AccuracyFormulasDpsCalc: Accuracy } = require('../dist/game/content/combat/formula/AccuracyFormulasDpsCalc');
const core = PluginManager.getCoreApi();
before(async () => {
  await CachePipeline.initialize(process.cwd()); new NpcDefinitionLoader().load();
  require('../plugins/combat/ElementalSpells.plugin').register(PluginManager.createApi('ElementalSpellsTest'));
  require('../plugins/combat/effects/ChaosGauntlets.EquipmentEffects')(PluginManager.createApi('ChaosGauntletsTest'));
  require('../dist/game/content/combat/EquipmentEffects').registerMagicAttackAccuracyModifier((p, roll) =>
    p.getAttribute?.('elemental-test:accuracy') ? Math.floor(roll * 1.5) : roll);
  const api=PluginManager.createApi('InvalidFormulaResultTest');
  for(const [stage,field] of [['combat:magic-base-max-hit','maxHit'],['combat:magic-max-hit','maxHit'],
    ['combat:magic-attack-roll','attackRoll']]) api.onCustomEvent(stage,request=>{
      if(request.attacker?.getAttribute?.('elemental-test:invalid-stage')===stage) {
        request[field]=request.attacker.getAttribute('elemental-test:invalid-value');
      }
    });
});

test('generic calculation stages reject nonfinite and negative plugin results', t => {
  for(const stage of ['combat:magic-base-max-hit','combat:magic-max-hit','combat:magic-attack-roll']) {
    for(const value of [NaN,Infinity,-1]) {
      const f=fixture(t,{spell:'FIRE_SURGE'});
      f.player.setAttribute('elemental-test:invalid-stage',stage);
      f.player.setAttribute('elemental-test:invalid-value',value);
      assert.equal(f.max(),24,stage);
      assert.equal(f.roll(),108*164,stage);
    }
  }
});

test('matching elemental amulets add two to the base for all four elements', t => {
  for (const [index, element] of ['WIND','WATER','EARTH','FIRE'].entries()) {
    const f = fixture(t, {spell:element+'_WAVE',type:index+1,magicDamage:50});
    const id = core.ItemIdentifiers['AMULET_OF_'+['AIR','WATER','EARTH','FIRE'][index]];
    assert.ok(Number.isInteger(id));
    f.player.getEquipment().getItems()[core.Equipment.AMULET_SLOT] = new core.Item(id);
    assert.equal(f.max(),46, 'floor(22*1.5)+floor(22*.6)');
    f.player.getEquipment().getItems()[core.Equipment.AMULET_SLOT] = new core.Item(core.ItemIdentifiers.AMULET_OF_GLORY);
    assert.equal(f.max(),42);
  }
});

test('Chaos gauntlets and matching amulets stack before equipment and weakness, using the actual spell', t => {
  const f = fixture(t, {spell:'FIRE_BOLT',magicDamage:50});
  f.player.getEquipment().getItems()[core.Equipment.HANDS_SLOT] = new core.Item(core.ItemIdentifiers.CHAOS_GAUNTLETS);
  assert.equal(f.max(core.CombatSpells.EARTH_BOLT),31, 'floor(15*1.5)+floor(15*.6)');
  f.player.getEquipment().getItems()[core.Equipment.AMULET_SLOT] = new core.Item(core.ItemIdentifiers.AMULET_OF_EARTH);
  assert.equal(f.max(core.CombatSpells.EARTH_BOLT),35, 'floor(17*1.5)+floor(17*.6)');
  assert.equal(f.max(),22,'wrong amulet and weakness do not apply to the selected Fire Bolt');
  assert.equal(f.max(core.CombatSpells.EARTH_WAVE),46,'gauntlets do not affect Wave');
});

test('the usable universal Elemental amulet matches every element; noted and placeholder variants do not', t => {
  for(const [index,element] of ['WIND','WATER','EARTH','FIRE'].entries()) {
    const f=fixture(t,{spell:element+'_BOLT',type:index+1,magicDamage:50});
    f.player.getEquipment().getItems()[core.Equipment.HANDS_SLOT]=new core.Item(core.ItemIdentifiers.CHAOS_GAUNTLETS);
    for(const [id,expected] of [[core.ItemIdentifiers.ELEMENTAL_AMULET,35],
      [core.ItemIdentifiers.ELEMENTAL_AMULET_2,31],[core.ItemIdentifiers.ELEMENTAL_AMULET_3,31]]) {
      f.player.getEquipment().getItems()[core.Equipment.AMULET_SLOT]=new core.Item(id);
      assert.equal(f.max(),expected,element+' '+id);
    }
  }
});

test('canonical Royal Titans and elementals use the shared damage and accuracy weakness once', t => {
  for (const [id, spell, damage] of [[14150,'WATER_WAVE',40],[14151,'FIRE_WAVE',40],
    [12596,'WATER_WAVE',30],[14147,'FIRE_WAVE',30],[14150,'FIRE_WAVE',20],[2085,'WATER_WAVE',20]]) {
    const f=fixture(t,{spell});
    t.mock.method(f.target,'getCurrentDefinition',()=>NpcDefinition.forId(id));
    assert.equal(f.max(),damage,String(id));
  }
  const base=108*164;
  for (const [id,spell,percent] of [[12596,'WATER_SURGE',50],[14147,'FIRE_SURGE',50],
    [12596,'FIRE_SURGE',0],[14150,'WATER_SURGE',100],[2085,'WATER_SURGE',0]]) {
    const f=fixture(t,{spell});
    t.mock.method(f.target,'getCurrentDefinition',()=>NpcDefinition.forId(id));
    assert.equal(f.roll(),base+Math.floor(base*percent/100),String(id));
  }
});

test('NPC weakness loader rejects invalid elements and invalid percentages', () => {
  const row=require('../data/definitions/monsters-complete.json')['12204'];
  for(const [type,percent,expected] of [[0,60,[0,0]],[5,60,[0,0]],[3,-1,[3,0]],
    [3,NaN,[3,0]],[3,Infinity,[3,0]],[3,60.9,[3,60]]]) {
    const result=NpcDefinitionLoader.fromMonsterDump({...row,elemental_weakness_type:type,elemental_weakness_percent:percent});
    assert.deepEqual([result.elementalWeaknessType,result.elementalWeaknessPercent],expected);
  }
  assert.deepEqual(NpcDefinition.forId(12205).getElementalWeakness(),{type:3,percent:60});
});

function fixture(t, { level = 99, current = level, spell = 'EARTH_SURGE', magicDamage = 0, type = 3, percent = 60 } = {}) {
  const player = new Player(null), definition = Object.assign(new NpcDefinition(), {
    elementalWeaknessType: type, elementalWeaknessPercent: percent,
  });
  let target = new NPC(12204, new core.Location(2655,6368));
  t.mock.method(player, 'getSession', () => ({ sendClientPacket: () => true }));
  t.mock.method(target, 'getCurrentDefinition', () => definition);
  t.mock.method(player.getCombat(), 'getTarget', () => target);
  player.getSkillManager().setMaxLevel(core.Skill.MAGIC, level);
  player.getSkillManager().setCurrentLevel(core.Skill.MAGIC, current, false);
  player.getCombat().setCastSpell(core.CombatSpells[spell]);
  player.getBonusManager().getOtherBonus()[core.BonusManager.MAGIC_STRENGTH] = magicDamage;
  player.getBonusManager().getAttackBonus()[core.BonusManager.ATTACK_MAGIC] = 100;
  return { player, definition, get target() { return target; },
    max(override) { return Damage.getMagicMaxhit(player, override); },
    roll() { return Accuracy.attackMagicRoll(player, target); },
    targetWithoutWeakness() {
      const other = new NPC(12204, new core.Location(2655,6368));
      t.mock.method(other, 'getCurrentDefinition', () => new NpcDefinition()); target = other;
    } };
}

test('the actual canonical Whisperer weakness survives the name-guarded NPC loader', () => {
  const row = require('../data/definitions/monsters-complete.json')['12204'];
  assert.equal(row.elemental_weakness_type, 3); assert.equal(row.elemental_weakness_percent, 60);
  const converted = NpcDefinitionLoader.fromMonsterDump(row);
  assert.equal(converted.elementalWeaknessType, 3); assert.equal(converted.elementalWeaknessPercent, 60);
  assert.deepEqual(NpcDefinition.forId(12204).getElementalWeakness(), { type:3, percent:60 });
});

test('matching elemental damage adds the base weakness bonus after equipment, rather than multiplying the geared max', t => {
  const f = fixture(t, { spell:'EARTH_WAVE', magicDamage:50 });
  assert.equal(f.max(), 42, 'floor(20*1.5)+floor(20*0.6), not48');
  const wrong = fixture(t, { spell:'FIRE_WAVE', magicDamage:50 });
  assert.equal(wrong.max(), 30);
});

test('all twenty standard elemental spells share their learned family maximum and only the matching element gains weakness', t => {
  const families = [['STRIKE',8],['BOLT',12],['BLAST',16],['WAVE',20],['SURGE',24]];
  for (const [family, maximum] of families) for (const [index, element] of ['WIND','WATER','EARTH','FIRE'].entries()) {
    const f = fixture(t, { spell:element+'_'+family, type:index+1, percent:50 });
    assert.equal(f.max(), maximum + Math.floor(maximum / 2), element+'_'+family);
  }
});

test('family scaling uses unboosted level, including learned-tier boundaries', t => {
  for (const [level, current, expected] of [[1,99,2],[4,99,2],[5,99,4],[8,99,4],[9,99,6],[12,99,6],[13,1,8]]) {
    const f = fixture(t, { level,current,spell:'WIND_STRIKE',percent:0 }); assert.equal(f.max(),expected);
  }
});

test('weakness accuracy adds from the raw roll and does not cache a target-specific bonus', t => {
  const f = fixture(t); f.player.setAttribute('elemental-test:accuracy', true);
  const base = 108 * 164;
  assert.equal(f.roll(), Math.floor(base * 1.5) + Math.floor(base * .6));
  f.targetWithoutWeakness(); assert.equal(f.roll(), Math.floor(base * 1.5));
});

test('an explicit spell override is used even when another spell is selected', t => {
  const f = fixture(t, { spell:'FIRE_SURGE' });
  assert.equal(f.max(core.CombatSpells.EARTH_SURGE), 38);
  assert.equal(f.max(),24);
});

test('other spellbooks and god spells do not receive elemental scaling or weakness', t => {
  for (const spell of ['ICE_BARRAGE','FLAMES_OF_ZAMORAK','IBAN_BLAST']) {
    const f = fixture(t, {spell,type:4,percent:100});const withWeakness=f.max();
    f.targetWithoutWeakness(); assert.equal(f.max(),withWeakness,spell);
  }
});
