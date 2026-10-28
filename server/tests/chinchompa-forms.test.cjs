const assert = require('node:assert/strict'), path = require('node:path');
const {before, after, test} = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const {CachePipeline} = require('../dist/game/cache/CachePipeline');
const {PluginManager: PM} = require('../dist/plugins/PluginManager');
const {Player} = require('../dist/game/entity/impl/player/Player');
const {PlayerSession} = require('../dist/net/PlayerSession');
const {ClientConnection} = require('../dist/net/NetworkBuilder');
let core, PlayerSave, next = 1250;
const forms = [['skillpethunter_red','skillpet_hunter_red'],['skillpethunter_grey','skillpet_hunter_grey'],['skillpethunter_black','skillpet_hunter_black']];
before(async () => { await CachePipeline.initialize(path.resolve(__dirname,'..')); PM.loadFromDirectory(path.resolve(__dirname,'../plugins')); core=PM.getCoreApi(); ({PlayerSave}=require('../dist/game/entity/impl/player/persistence/PlayerSave')); core.RegionManager.init(); core.RegionManager.loadMapFiles(3222,3218); core.RegionManager.loadMapFiles(2611,3295); PM.emitServerStartup({}); });
after(() => PM.emitServerShutdown({}));
const item = name => core.CacheDefinitions.getObjId(name);
const npcId = name => core.CacheDefinitions.getNpcId(name);
function actor(t) {
  const channel={kind:'test',remoteAddress:'127.0.0.1',isOpen:()=>true,send:()=>true,close(){},onData(){},onError(){},onClose(){}};
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('chinform'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
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
  assert.ok(index>=0, 'the active cache definition must expose '+name);
  await send(f,{type:'npc_option',index:n.getIndex(),clickType:index+1});
}
async function summon(f,name='skillpethunter_red') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}


for(const [obj,npc] of forms) test('native Drop/Pick-up preserves '+obj,async t=>{
 const f=actor(t),n=await summon(f,obj);assert.equal(n.getId(),npcId(npc));await action(f,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item(obj)),1);assert.equal(f.p.getAttribute('pets:current'),null);
});
test('native free morph records the physical item, one family and only the base collection entry',async t=>{
 const f=actor(t),n=await summon(f);for(let i=1;i<=3;i++){await action(f,n,'Metamorphosis');const [obj,npc]=forms[i%3];assert.equal(n.getId(),npcId(npc));assert.equal(f.p.getAttribute('pets:active-item'),item(obj));assert.deepEqual(f.p.getAttribute('pets.owned'),[item(obj)]);}
 const log=f.p.getAttribute('clog.items');assert.equal(log[item('skillpethunter_grey')],1);assert.equal(log[item('skillpethunter_red')],undefined);assert.equal(log[item('skillpethunter_black')],undefined);
});
test('legacy base item and chosen variant migrate once without converting another base copy',async t=>{
 const f=actor(t);f.p.setAttribute('pets.owned',[item('skillpethunter_red')]);f.p.setAttribute('pets:variant',{['skill:hunter']:npcId('skillpet_hunter_grey')});f.p.getInventory().add(new core.Item(item('skillpethunter_red'),2),true);
 const n=await drop(f,item('skillpethunter_red'));assert.equal(n.getId(),npcId('skillpet_hunter_grey'));await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpethunter_grey')),1);assert.equal(f.p.getInventory().getAmount(item('skillpethunter_red')),1);
 const base=await drop(f,item('skillpethunter_red'));assert.equal(base.getId(),npcId('skillpet_hunter_red'));
});
test('real Bank round trip preserves explicit alternate item despite changed family preference',async t=>{
 const f=actor(t),n=await summon(f,'skillpethunter_grey');await action(f,n,'Pick-up');f.p.getBank(0).open();core.Bank.deposit(f.p,item('skillpethunter_grey'),f.p.getInventory().getSlotForItemId(item('skillpethunter_grey')),1,false);assert.equal(f.p.getBank(0).getAmount(item('skillpethunter_grey')),1);
 const other=await summon(f);await action(f,other,'Pick-up');f.p.getBank(0).open();core.Bank.withdraw(f.p,item('skillpethunter_grey'),f.p.getBank(0).getSlotForItemId(item('skillpethunter_grey')),1,0);const returned=await drop(f,item('skillpethunter_grey'));assert.equal(returned.getId(),npcId('skillpet_hunter_grey'));
});
test('actual save/login restores the morphed follower without a duplicate physical pet',async t=>{
 const f=actor(t),n=await summon(f);await action(f,n,'Metamorphosis');PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});g.p.needsPlacement=false;
 const restored=g.p.getAttribute('pets:current');assert.equal(restored?.getId(),npcId('skillpet_hunter_grey'));assert.equal(g.p.getAttribute('pets:active-item'),item('skillpethunter_grey'));await action(g,restored,'Pick-up');assert.equal(g.p.getInventory().getAmount(item('skillpethunter_grey')),1);assert.equal(g.p.getInventory().getAmount(item('skillpethunter_red')),0);
});
test('full bag and foreign pickup preserve current form until the owner frees a slot',async t=>{
 const f=actor(t),other=actor(t),n=await summon(f);await action(f,n,'Metamorphosis');while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);await action(f,n,'Pick-up');assert.equal(f.p.getAttribute('pets:current'),n);await action(other,n,'Pick-up');assert.equal(other.p.getInventory().getAmount(item('skillpethunter_grey')),0);f.p.getInventory().deleteAtSlot(27);await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpethunter_grey')),1);
});

test('morph records current physical identity before loss, and Probita reclaims that form only once',async t=>{
  const f=actor(t),n=await summon(f);await action(f,n,'Metamorphosis');assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpethunter_grey')]);
  PM.emitCustomEvent('pets:release',{player:f.p,npc:n});f.p.setLocation(new core.Location(2611,3295,0));f.p.needsPlacement=false;
  const probita=core.NPC.create(core.NpcIdentifiers.PROBITA,new core.Location(2612,3295,0));core.World.getNpcs().add(probita);t.after(()=>core.World.getNpcs().remove(probita));
  PM.emitCustomEvent('npc-dialogue:action',{player:f.p,npc:probita,npcId:probita.getId(),action:'open_interface',target:'Pet Insurance'});core.TaskManager.process();core.TaskManager.process();
  const row=[...core.CacheDefinitions.getEnumValues(985)].find(([,id])=>id===item('skillpethunter_red'))[0];
  for(const child of [11,37,37])await send(f,{type:'widget_action',widgetId:(148<<16)|child,groupId:148,childId:child,slot:child===11?6+5*row:0,buttonNum:1});
  assert.equal(f.p.getInventory().getAmount(item('skillpethunter_grey')),1);assert.equal(f.p.getInventory().getAmount(item('skillpethunter_red')),0);
});


for(const[obj]of forms)test('native ordinary chinchompa conversation is reachable for '+obj,async t=>{const f=actor(t),n=await summon(f,obj);await action(f,n,'Talk-to');assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.(),'Squeak squeak!');await send(f,{type:'dialogue_continue',widgetId:(231<<16)|5,childIndex:-1});assert.equal(f.p.getDialogueManager().isActive(),false);});
for(const[source,obj,npc]of [['CHINCHOMPA','skillpethunter_grey','skillpet_hunter_grey'],['CARNIVOROUS_CHINCHOMPA','skillpethunter_red','skillpet_hunter_red'],['BLACK_CHINCHOMPA','skillpethunter_black','skillpet_hunter_black']])test('actual Hunter XP/success boundary selects source colour '+source,t=>{const f=actor(t);t.mock.method(Math,'random',()=>0);require('../plugins/skills/hunter/Context.Hunter').xp(f.p,100,'box-trap',core.NpcIdentifiers[source]);assert.equal(f.p.getAttribute('pets:current')?.getId(),npcId(npc));assert.deepEqual(f.p.getAttribute('pets.owned'),[item(obj)]);assert.equal(f.p.getAttribute('clog.items')[item('skillpethunter_grey')],1);});

test('the actual Collection Log and insurance cache use different canonical chinchompa base items',()=>{const data=require('../plugins/achievements/collectionlog/Data.CollectionLog');assert.equal(data.isLogged(item('skillpethunter_grey')),true);assert.equal(data.isLogged(item('skillpethunter_red')),false);assert.equal([...core.CacheDefinitions.getEnumValues(985)].find(([slot])=>slot===27)[1],item('skillpethunter_red'));});
