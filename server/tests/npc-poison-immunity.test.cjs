const assert = require('node:assert/strict');
const {test} = require('node:test');
const {Server} = require('../dist/Server');
Server.installProductionPathResolver();
const {CombatFactory} = require('../dist/game/content/combat/CombatFactory');
const {CombatPoisonEffect} = require('../dist/game/task/impl/CombatPoisonEffect');
const {TaskManager} = require('../dist/game/task/TaskManager');
const {NpcDefinition} = require('../dist/game/definition/NpcDefinition');
const {NpcDefinitionLoader} = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');

function victim(t, {poison=false, venom=false, severity=0, venomed=false, player=false, immunity=false}={}) {
  const definition=Object.assign(new NpcDefinition(),{immunePoison:poison,immuneVenom:venom});
  const tasks=[], messages=[];
  t.mock.method(TaskManager,'submit',task=>tasks.push(task));
  const entity={
    isPlayer:()=>player,isNpc:()=>!player,getAsNpc:()=>entity,getCurrentDefinition:()=>definition,
    isVenomed:()=>venomed&&severity>0,isPoisoned:()=>severity>0,getPoisonDamage:()=>severity,
    setPoisonDamage:n=>severity=n,setVenomed:b=>venomed=b,
    getCombat:()=>({getPoisonImmunityTimer:()=>({finished:()=>!immunity}),
      getPoisonClock:()=>({finished:()=>!immunity,isVenomImmune:()=>immunity,clearCounter(){}})}),
    sendMessage:text=>messages.push(text),
  };
  return {entity,definition,tasks,messages};
}

test('dedicated status data is the sole immunity authority, separate from combat stats',()=>{
  const stats=NpcDefinitionLoader.fromMonsterDump({immune_poison:true,immune_venom:true,poisonous:false,venomous:false});
  assert.equal(stats.immunePoison,undefined);assert.equal(stats.immuneVenom,undefined);
  const definition=Object.assign(new NpcDefinition(),stats);
  NpcDefinitionLoader.applyStatusImmunities(definition,'Fixture',{name:'Fixture',immune_poison:true,immune_venom:true});
  assert.equal(definition.isPoisonImmune(),true);assert.equal(definition.isVenomImmune(),true);
  NpcDefinitionLoader.applyStatusImmunities(definition,'Fixture',{name:'Fixture',immune_poison:false,immune_venom:false});
  assert.equal(definition.isPoisonImmune(),false);assert.equal(definition.isVenomImmune(),false);
});

test('status join guards cache identity and rejects truthy non-booleans',()=>{
  const definition=new NpcDefinition();
  NpcDefinitionLoader.applyStatusImmunities(definition,'Fixture',{name:'Other',immune_poison:true,immune_venom:true});
  assert.equal(definition.isPoisonImmune(),false);assert.equal(definition.isVenomImmune(),false);
  NpcDefinitionLoader.applyStatusImmunities(definition,'Fixture',{name:'Fixture',immune_poison:'true',immune_venom:1});
  assert.equal(definition.isPoisonImmune(),false);assert.equal(definition.isVenomImmune(),false);
  NpcDefinitionLoader.applyStatusImmunities(definition,'Fixture',undefined);
  assert.equal(definition.isPoisonImmune(),false);
});

test('an NPC immune to both statuses rejects poison and venom without creating a task',t=>{
  const f=victim(t,{poison:true,venom:true});
  CombatFactory.poisonEntity(f.entity,30,1);CombatFactory.poisonEntity(f.entity,6,2);
  assert.equal(f.entity.getPoisonDamage(),0);assert.equal(f.entity.isVenomed(),false);assert.equal(f.tasks.length,0);
});

test('venom immunity converts an otherwise susceptible NPC to decaying ordinary poison',t=>{
  const f=victim(t,{venom:true});CombatFactory.poisonEntity(f.entity,6,2);
  assert.equal(f.entity.isVenomed(),false);assert.equal(CombatPoisonEffect.damageFromSeverity(f.entity.getPoisonDamage()),6);
  assert.equal(f.tasks.length,1);
});

test('converted venom neither weakens stronger poison nor schedules a duplicate poison task',t=>{
  const f=victim(t,{venom:true,severity:50});CombatFactory.poisonEntity(f.entity,6,2);
  assert.equal(f.entity.isVenomed(),false);assert.equal(f.entity.getPoisonDamage(),50);assert.equal(f.tasks.length,0);
});

test('poison immunity alone does not reject a genuinely venom-susceptible NPC',t=>{
  const f=victim(t,{poison:true});CombatFactory.poisonEntity(f.entity,6,2);
  assert.equal(f.entity.isVenomed(),true);assert.equal(f.entity.getPoisonDamage(),6);assert.equal(f.tasks.length,1);
});

test('ordinary susceptible NPCs retain venom and cannot be downgraded by later poison',t=>{
  const f=victim(t);CombatFactory.poisonEntity(f.entity,6,2);CombatFactory.poisonEntity(f.entity,30,1);
  assert.equal(f.entity.isVenomed(),true);assert.equal(f.entity.getPoisonDamage(),6);assert.equal(f.tasks.length,1);
});

test('player poison immunity and player venom applications keep their original paths',t=>{
  const immune=victim(t,{player:true,immunity:true});CombatFactory.poisonEntity(immune.entity,6,2);
  assert.equal(immune.entity.getPoisonDamage(),0);assert.equal(immune.tasks.length,0);
  const f=victim(t,{player:true,poison:true,venom:true});CombatFactory.poisonEntity(f.entity,6,2);
  assert.equal(f.entity.isVenomed(),true);assert.equal(f.entity.getPoisonDamage(),6);assert.equal(f.messages.length,1);
});

test('canonical status export governs real normal bosses while existing larva stats stay intact',async t=>{
  const path=require('node:path');
  const {CachePipeline}=require('../dist/game/cache/CachePipeline');
  const {NPC}=require('../dist/game/entity/impl/npc/NPC');
  const {Location}=require('../dist/game/model/Location');
  await CachePipeline.initialize(path.resolve(__dirname,'..'));
  new NpcDefinitionLoader().load();
  const tasks=[];t.mock.method(TaskManager,'submit',task=>tasks.push(task));
  for(const [id,poisonImmune] of [[12191,false],[12214,false],[12204,true]]){
    const npc=new NPC(id,new Location(3222,3218,0));
    assert.equal(npc.getCurrentDefinition().isPoisonImmune(),poisonImmune);
    assert.equal(npc.getCurrentDefinition().isVenomImmune(),true);
    CombatFactory.poisonEntity(npc,6,2);
    assert.equal(npc.isVenomed(),false);
    assert.equal(npc.getPoisonDamage(),poisonImmune?0:30);
  }
  assert.equal(tasks.length,2);
  for(const [id,hp]of [[14710,2],[14711,2],[14712,2],[14713,2],[14788,4],[14789,4]]){
    const definition=NpcDefinition.forId(id);
    assert.equal(definition.getHitpoints(),hp,'existing larva HP '+id);
    assert.equal(definition.isDemon(),true,'existing larva demon attribute '+id);
  }
});

test('ordinary poison and venom strike on thirty-tick intervals rather than drifting to thirty-one',()=>{
  for(const venomed of [false,true]){
    let severity=venomed?6:30;
    const hits=[];
    const entity={isRegistered:()=>true,isPlayer:()=>false,getHitpoints:()=>99,isPoisoned:()=>severity>0,
      isVenomed:()=>venomed,getVenomGeneration:()=>0,getPoisonDamage:()=>severity,setPoisonDamage:n=>severity=n,
      getCombat:()=>({getPoisonImmunityTimer:()=>({finished:()=>true}),
        getHitQueue:()=>({addPendingDamage:parts=>hits.push(...parts)})})};
    const effect=new CombatPoisonEffect(entity);
    for(let tick=1;tick<30;tick++)effect.execute();assert.equal(hits.length,0);
    effect.execute();assert.equal(hits.length,1,'first hit on tick30');assert.equal(hits[0].getDamage(),6);
    for(let tick=31;tick<60;tick++)effect.execute();assert.equal(hits.length,1);
    effect.execute();assert.equal(hits.length,2,'next hit on tick60');assert.equal(hits[1].getDamage(),venomed?8:6);
  }
});

test('a status-only NPC is loaded even without combat or animation records',t=>{
  const {CacheDefinitions}=require('../dist/game/cache/CacheDefinitions');
  const id=12203, name=CacheDefinitions.getNpc(id).name;
  const loader=new NpcDefinitionLoader();
  t.mock.method(loader,'read',()=>({}));
  t.mock.method(loader,'readOptional',(_directory,file)=>file==='npc-status-immunities.json'
    ? {schema_version:1,npcs:{[id]:{name,immune_poison:true,immune_venom:true}}}:{});
  loader.load();
  assert.equal(NpcDefinition.forId(id).isPoisonImmune(),true);
  assert.equal(NpcDefinition.forId(id).isVenomImmune(),true);
});
