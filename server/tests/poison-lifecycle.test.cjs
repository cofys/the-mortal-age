const assert=require('node:assert/strict');
const {test}=require('node:test');
const {Server}=require('../dist/Server');Server.installProductionPathResolver();
const {Player}=require('../dist/game/entity/impl/player/Player');
const {PlayerSave}=require('../dist/game/entity/impl/player/persistence/PlayerSave');
const {GameConstants}=require('../dist/game/GameConstants');
const {TaskManager}=require('../dist/game/task/TaskManager');
const {CombatPoisonEffect}=require('../dist/game/task/impl/CombatPoisonEffect');
const {curePoisonAndVenom}=require('../plugins/items/ConsumableEffects');

function player(t,venom=false){
 const p=new Player(null);p.setRegistered(true);p.setPoisonDamage(venom?10:27);p.setVenomed(venom);
 t.mock.method(p,'isPlayerBot',()=>true);
 t.mock.method(p.getTrading(),'closeTrade',()=>{});
 t.mock.method(p.getRelations(),'updateLists',()=>{});
 const sender=new Proxy({},{get:(_,key)=>key==='hasInterruptibleInterface'?()=>false:()=>sender});
 t.mock.method(p,'getPacketSender',()=>sender);
 t.after(()=>{p.setRegistered(false);CombatPoisonEffect.suspend(p);TaskManager.cancelTasks(p);});return p;
}

test('real logout cancellation preserves poison and venom in the save snapshot',t=>{
 let snapshot;
 t.mock.method(GameConstants.PLAYER_PERSISTENCE,'cancelRequestedSave',()=>{});
 t.mock.method(GameConstants.PLAYER_PERSISTENCE,'save',p=>{snapshot=PlayerSave.fromPlayer(p);});
 for(const venom of [false,true]){
  const p=player(t,venom),effect=new CombatPoisonEffect(p);TaskManager.submit(effect);
  p.setRegistered(false);p.onLogout();
  assert.equal(effect.isRunning(),false);
  assert.equal(snapshot.getPoisonDamage(),venom?10:27);
  assert.equal(snapshot.isVenomed(),venom);
 }
});

test('loading a poisoned save restarts exactly one damage task on login',t=>{
 for(const venom of [false,true]){
  const original=player(t,venom),save=PlayerSave.fromPlayer(original),loaded=player(t);
  save.applyToPlayer(loaded);loaded.setRegistered(true);
  const submitted=[],submit=TaskManager.submit.bind(TaskManager);
  t.mock.method(TaskManager,'submit',task=>{submitted.push(task);submit(task);});
  loaded.onLogin();loaded.onLogin();
  const poison=submitted.filter(task=>task instanceof CombatPoisonEffect);
  assert.equal(poison.length,1,'repeated login setup must not double poison ticks');
  assert.equal(loaded.getPoisonDamage(),venom?10:27);
  assert.equal(CombatPoisonEffect.orbValue(loaded),venom?1000002:27);
  const hits=[];t.mock.method(loaded.getCombat().getHitQueue(),'addPendingDamage',values=>hits.push(...values));
  for(let i=0;i<35;i++)poison[0].tick();
  assert.deepEqual(hits.map(hit=>hit.getDamage()),[venom?10:6],'the restored task actually damages with its saved progression');
  assert.equal(loaded.getPoisonDamage(),venom?12:26);
  t.mock.restoreAll();
 }
});

test('replaced and cancelled tasks cannot alter a newer affliction',t=>{
 const p=player(t,true),old=new CombatPoisonEffect(p);TaskManager.submit(old);
 const current=new CombatPoisonEffect(p);TaskManager.submit(current);
 let hits=0;t.mock.method(p.getCombat().getHitQueue(),'addPendingDamage',()=>{hits++;});
 assert.equal(old.isRunning(),false);
 for(let i=0;i<35;i++)old.execute();
 assert.equal(hits,0);assert.equal(p.getPoisonDamage(),10);
 old.stop();for(let i=0;i<35;i++)current.tick();
 assert.equal(hits,1);assert.equal(p.getPoisonDamage(),12);
});

test('cancelling player activity tasks does not suspend or restart the poison clock',t=>{
 const p=player(t,true),effect=new CombatPoisonEffect(p);TaskManager.submit(effect);
 let hits=0;t.mock.method(p.getCombat().getHitQueue(),'addPendingDamage',()=>{hits++;});
 for(let i=0;i<15;i++)effect.tick();
 TaskManager.cancelTasks(p);
 assert.equal(effect.isRunning(),true,'bot movement reset is activity cancellation, not logout');
 for(let i=0;i<20;i++)effect.tick();
 assert.equal(hits,1);assert.equal(p.getPoisonDamage(),12);
});

test('explicit cures and natural expiry end damage while an antidote retains its protection task',t=>{
 for(const reason of ['antidote','cure','expiry']){
  const p=player(t,reason!=='expiry');
  if(reason==='expiry')p.setPoisonDamage(1);
  const effect=new CombatPoisonEffect(p);TaskManager.submit(effect);
  if(reason==='antidote'){curePoisonAndVenom(p);p.getCombat().getPoisonImmunityTimer().start(60);}
  if(reason==='cure')curePoisonAndVenom(p);
  const hits=[];t.mock.method(p.getCombat().getHitQueue(),'addPendingDamage',values=>hits.push(...values));
  for(let i=0;i<35;i++)effect.tick();
  assert.equal(effect.isRunning(),reason==='antidote',reason);assert.equal(p.getPoisonDamage(),0,reason);assert.equal(p.isVenomed(),false,reason);
  assert.deepEqual(hits.map(hit=>hit.getDamage()),reason==='expiry'?[1]:[],reason);
 }
});

test('a detached poison task stops without damaging or curing its saved actor',t=>{
 const p=player(t,true),effect=new CombatPoisonEffect(p);TaskManager.submit(effect);
 p.setRegistered(false);effect.execute();
 assert.equal(effect.isRunning(),false);assert.equal(p.getPoisonDamage(),10);assert.equal(p.isVenomed(),true);
});

test('a registered dead actor is cured before another poison damage can queue',t=>{
 const p=player(t,true),effect=new CombatPoisonEffect(p);TaskManager.submit(effect);
 t.mock.method(p,'getHitpoints',()=>0);
 let hits=0;t.mock.method(p.getCombat().getHitQueue(),'addPendingDamage',()=>{hits++;});
 for(let i=0;i<35;i++)effect.execute();
 assert.equal(hits,0);assert.equal(p.getPoisonDamage(),0);assert.equal(p.isVenomed(),false);assert.equal(effect.isRunning(),false);
});
