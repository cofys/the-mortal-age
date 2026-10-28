const assert = require('node:assert/strict'), path = require('node:path');
const {before, after, test} = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const {CachePipeline} = require('../dist/game/cache/CachePipeline');
const {PluginManager: PM} = require('../dist/plugins/PluginManager');
const {Player} = require('../dist/game/entity/impl/player/Player');
const {PlayerSession} = require('../dist/net/PlayerSession');
const {ClientConnection} = require('../dist/net/NetworkBuilder');
const {PlayerSave} = require('../dist/game/entity/impl/player/persistence/PlayerSave');
let core, next = 1250;
const forms = [['olmpet','raids_olm_pet'], ['dogadilepet','dogadile_pet'], ['tektonpet','tekton_pet'],
  ['tektonenragedpet','tekton_enraged_pet'], ['vanguardpet','vanguard_pet'], ['vasapet','vasa_pet'],
  ['vespulapet','vespula_pet'], ['vespulaflyingpet','vespula_flying_pet']];
before(async () => { await CachePipeline.initialize(path.resolve(__dirname,'..')); PM.loadFromDirectory(path.resolve(__dirname,'../plugins')); core=PM.getCoreApi(); core.RegionManager.init(); core.RegionManager.loadMapFiles(3222,3218); core.RegionManager.loadMapFiles(2611,3295); PM.emitServerStartup({}); });
after(() => PM.emitServerShutdown({}));
const item = name => core.CacheDefinitions.getObjId(name);
const npcId = name => core.CacheDefinitions.getNpcId(name);
function actor(t) {
  const channel={kind:'test',remoteAddress:'127.0.0.1',isOpen:()=>true,send:()=>true,close(){},onData(){},onError(){},onClose(){}};
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('olmforms'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
  const c=new ClientConnection(channel); c.player=p;
  t.after(()=>{PM.emitPlayerLogout({player:p,username:p.getUsername()});p.setRegistered(false);core.TaskManager.cancelTasks(p.getIndex());for(const n of [...core.World.getNpcs()])if(n?.getOwner?.()===p)core.World.getNpcs().remove(n);});
  return {p,c};
}
async function drain(f) { for(let i=0;i<10;i++){core.TaskManager.processWalkTo(f.p.getIndex());f.p.getMovementQueue().process();core.TaskManager.process();} }
async function send(f, packet) {await f.c.dispatch([packet]);f.c.processTurnPackets();await drain(f);}
async function drop(f,id) {f.p.getPacketSender().sendInterfaceRemoval();await send(f,{type:'inventory_action',slot:f.p.getInventory().getSlotForItemId(id),itemId:id,widgetId:149<<16,option:'Drop',optionIndex:5});return f.p.getAttribute('pets:current');}
async function action(f,n,name) {
  f.p.getPacketSender().sendInterfaceRemoval(); n.setLocation(new core.Location(f.p.getLocation().getX()+1,f.p.getLocation().getY(),0));
  const actions=n.getDefinition().getActions(), index=actions.findIndex(a=>a===name);
  // The client inserts these operations only for the old Olmlet definition.
  const clickType=index>=0?index+1: name==='Metamorphosis'?2:3;
  await send(f,{type:'npc_option',index:n.getIndex(),clickType});
}
async function summon(f,name='olmpet') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}
function unlock(f) {f.p.setAttribute('pets:morph-unlocks',['item:'+item('olmpet')]);}

for(const [obj,npc] of forms) test(`native Drop/Pick-up retains ${obj}'s cache item identity`,async t=>{
  const f=actor(t),n=await summon(f,obj);assert.equal(n.getId(),npcId(npc));
  await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item(obj)),1);assert.equal(f.p.getAttribute('pets:current'),null);
});

test('native unlocked cycle reaches all eight forms and keeps one base collection entry',async t=>{
  const f=actor(t),n=await summon(f);unlock(f);const seen=new Set();
  for(let i=0;i<8;i++){seen.add(n.getId());await action(f,n,'Metamorphosis');}
  assert.deepEqual([...seen].sort((a,b)=>a-b),forms.map(([,name])=>npcId(name)).sort((a,b)=>a-b));
  const owns={player:f.p,itemId:item('dogadilepet'),owns:false};PM.emitCustomEvent('pets:owns',owns);assert.equal(owns.owns,true);
  assert.equal(f.p.getAttribute('pets.owned').length,1);
  const logged=f.p.getAttribute('clog.items');assert.equal(logged[item('olmpet')],1);
  for(const [name] of forms.slice(1))assert.equal(logged[item(name)],undefined);
});

test('real bank transfer and another form preference cannot change an explicit item on Drop',async t=>{
  const f=actor(t),n=await summon(f,'vespulaflyingpet');unlock(f);await action(f,n,'Pick-up');
  f.p.getBank(0).open();core.Bank.deposit(f.p,item('vespulaflyingpet'),f.p.getInventory().getSlotForItemId(item('vespulaflyingpet')),1,false);
  assert.equal(f.p.getBank(0).getAmount(item('vespulaflyingpet')),1);
  const other=await summon(f,'olmpet');await action(f,other,'Pick-up');
  f.p.getBank(0).open();
  core.Bank.withdraw(f.p,item('vespulaflyingpet'),f.p.getBank(0).getSlotForItemId(item('vespulaflyingpet')),1,0);
  const restored=await drop(f,item('vespulaflyingpet'));assert.equal(restored.getId(),npcId('vespula_flying_pet'));
});

test('legacy base-item ownership and saved form migrate once, preserving unlock and a separate base copy',async t=>{
  const f=actor(t);unlock(f);f.p.setAttribute('pets.owned',[item('olmpet')]);f.p.setAttribute('pets:variant',{['item:'+item('olmpet')]:npcId('dogadile_pet')});
  f.p.getInventory().add(new core.Item(item('olmpet'),2),true);const n=await drop(f,item('olmpet'));assert.equal(n.getId(),npcId('dogadile_pet'));
  await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('dogadilepet')),1);assert.equal(f.p.getInventory().getAmount(item('olmpet')),1);
  const base=await drop(f,item('olmpet'));assert.equal(base.getId(),npcId('raids_olm_pet'));await action(f,base,'Metamorphosis');assert.equal(base.getId(),npcId('dogadile_pet'));
});

test('morph records current physical identity before loss, and Probita reclaims that form only once',async t=>{
  const f=actor(t),n=await summon(f);unlock(f);await action(f,n,'Metamorphosis');assert.deepEqual(f.p.getAttribute('pets.owned'),[item('dogadilepet')]);
  PM.emitCustomEvent('pets:release',{player:f.p,npc:n});f.p.setLocation(new core.Location(2611,3295,0));f.p.needsPlacement=false;
  const probita=core.NPC.create(core.NpcIdentifiers.PROBITA,new core.Location(2612,3295,0));core.World.getNpcs().add(probita);t.after(()=>core.World.getNpcs().remove(probita));
  PM.emitCustomEvent('npc-dialogue:action',{player:f.p,npc:probita,npcId:probita.getId(),action:'open_interface',target:'Pet Insurance'});core.TaskManager.process();core.TaskManager.process();
  const row=[...core.CacheDefinitions.getEnumValues(985)].find(([,id])=>id===item('olmpet'))[0];
  for(const child of [11,37,37])await send(f,{type:'widget_action',widgetId:(148<<16)|child,groupId:148,childId:child,slot:child===11?6+5*row:0,buttonNum:1});
  assert.equal(f.p.getInventory().getAmount(item('dogadilepet')),1);assert.equal(f.p.getInventory().getAmount(item('olmpet')),0);
});

test('new flying form survives real logout, PlayerSave and fresh login without another dust',async t=>{
  const f=actor(t),n=await summon(f,'vespulaflyingpet');unlock(f);PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});
  const g=actor(t);PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});g.p.needsPlacement=false;
  assert.equal(g.p.getAttribute('pets:current')?.getId(),npcId('vespula_flying_pet'));assert.equal(g.p.getInventory().getAmount(item('vespulaflyingpet')),0);
});

test('repeat dust Use on an alternate form retains dust and its permanent unlock',async t=>{
  const f=actor(t),n=await summon(f,'tektonenragedpet');unlock(f);const dust=core.ItemIdentifiers.METAMORPHIC_DUST;
  f.p.getInventory().add(new core.Item(dust,2),true);n.setLocation(new core.Location(3223,3218,0));
  await send(f,{type:'item_on_npc',targetIndex:n.getIndex(),itemId:dust,slot:f.p.getInventory().getSlotForItemId(dust),widgetId:149<<16});
  assert.equal(f.p.getInventory().getAmount(dust),2);assert.equal(n.getId(),npcId('tekton_enraged_pet'));
});

test('full inventory and a foreign native pickup cannot duplicate the new forms',async t=>{
  const f=actor(t),other=actor(t),n=await summon(f,'tektonenragedpet');
  while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);
  await action(f,n,'Pick-up');assert.equal(f.p.getAttribute('pets:current'),n);assert.equal(f.p.getInventory().getAmount(item('tektonenragedpet')),0);
  await action(other,n,'Pick-up');assert.equal(other.p.getInventory().getAmount(item('tektonenragedpet')),0);
  f.p.getInventory().deleteAtSlot(27);await action(f,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('tektonenragedpet')),1);
});

test('native morph cannot change the current form while dead or in an actual trade',async t=>{
  const f=actor(t),other=actor(t),n=await summon(f);unlock(f);f.p.setHitpoints(0);await action(f,n,'Metamorphosis');assert.equal(n.getId(),npcId('raids_olm_pet'));
  f.p.setHitpoints(10);f.p.getTrading().requestTrade(other.p);other.p.getTrading().requestTrade(f.p);assert.equal(f.p.getStatus(),core.PlayerStatus.TRADING);
  // Direct native dispatch must not depend on the browser hiding the operation.
  await send(f,{type:'npc_option',index:n.getIndex(),clickType:2});assert.equal(n.getId(),npcId('raids_olm_pet'));f.p.getTrading().closeTrade();
});

test('Probita retains a legacy lost form before the first summon after migration',async t=>{
  const f=actor(t);unlock(f);f.p.setAttribute('pets.owned',[item('olmpet')]);f.p.setAttribute('pets:variant',{['item:'+item('olmpet')]:npcId('dogadile_pet')});
  f.p.setLocation(new core.Location(2611,3295,0));f.p.needsPlacement=false;
  const npc=core.NPC.create(core.NpcIdentifiers.PROBITA,new core.Location(2612,3295,0));core.World.getNpcs().add(npc);t.after(()=>core.World.getNpcs().remove(npc));
  PM.emitCustomEvent('npc-dialogue:action',{player:f.p,npc,npcId:npc.getId(),action:'open_interface',target:'Pet Insurance'});core.TaskManager.process();core.TaskManager.process();
  const row=[...core.CacheDefinitions.getEnumValues(985)].find(([,id])=>id===item('olmpet'))[0];
  for(const child of [11,37])await send(f,{type:'widget_action',widgetId:(148<<16)|child,groupId:148,childId:child,slot:child===11?6+5*row:0,buttonNum:1});
  assert.equal(f.p.getInventory().getAmount(item('dogadilepet')),1);assert.equal(f.p.getInventory().getAmount(item('olmpet')),0);
});

test('legacy migrated follower records its resolved physical form through actual shutdown and fresh login',async t=>{
  const f=actor(t);f.p.setRegistered(false);assert.equal(core.World.getPlayers().add(f.p),true);f.p.needsPlacement=false;
  f.p.setAttribute('pets.owned',[item('olmpet')]);f.p.setAttribute('pets:variant',{['item:'+item('olmpet')]:npcId('dogadile_pet')});unlock(f);
  const n=await summon(f);assert.equal(n.getId(),npcId('dogadile_pet'));assert.equal(f.p.getAttribute('pets:active-item'),item('dogadilepet'));
  PM.emitServerShutdown({timestamp:Date.now()});const g=actor(t);PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);
  PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});g.p.needsPlacement=false;
  assert.equal(g.p.getAttribute('pets:current')?.getId(),npcId('dogadile_pet'));assert.equal(g.p.getAttribute('pets:active-item'),item('dogadilepet'));
  assert.equal(g.p.getInventory().getAmount(item('olmpet')),0);assert.equal(g.p.getInventory().getAmount(item('dogadilepet')),0);
});
