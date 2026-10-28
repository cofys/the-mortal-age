const assert = require('node:assert/strict'), path = require('node:path');
const {before, after, test} = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const {CachePipeline} = require('../dist/game/cache/CachePipeline');
const {PluginManager: PM} = require('../dist/plugins/PluginManager');
const {Player} = require('../dist/game/entity/impl/player/Player');
const {PlayerSession} = require('../dist/net/PlayerSession');
const {ClientConnection} = require('../dist/net/NetworkBuilder');
let core, PlayerSave, next = 1250;
before(async () => { await CachePipeline.initialize(path.resolve(__dirname,'..')); PM.loadFromDirectory(path.resolve(__dirname,'../plugins')); core=PM.getCoreApi(); ({PlayerSave}=require('../dist/game/entity/impl/player/persistence/PlayerSave')); core.RegionManager.init(); core.RegionManager.loadMapFiles(3222,3218); core.RegionManager.loadMapFiles(2611,3295); PM.emitServerStartup({}); });
after(() => PM.emitServerShutdown({}));
const item = name => core.CacheDefinitions.getObjId(name);
const npcId = name => core.CacheDefinitions.getNpcId(name);
function actor(t) {
  const channel={kind:'test',remoteAddress:'127.0.0.1',isOpen:()=>true,send:()=>true,close(){},onData(){},onError(){},onClose(){}};
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('beaverqa'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
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
async function summon(f,name='skillpetwc') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}



test('native Beaver Drop uses the current cache follower, not Cordelia',async t=>{const f=actor(t),n=await summon(f);assert.equal(n.getId(),npcId('skillpetwc'));assert.equal(n.getDefinition().getName(),'Beaver');assert.ok(n.getDefinition().getActions().includes('Pick-up'));await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),1);});
test('real native Woodcutting success awards the Beaver follower with one insured base item',async t=>{
 const f=actor(t);f.p.getInventory().add(new core.Item(core.ItemIdentifiers.BRONZE_AXE),true);const tree=new core.GameObject(core.ObjectIdentifiers.TREE,new core.Location(3223,3218,0),10,0,null);core.ObjectManager.register(tree,true);t.after(()=>core.ObjectManager.deregister(tree,true));t.mock.method(Math,'random',()=>0);
 await send(f,{type:'object_option',id:tree.getId(),x:3223,y:3218,action:'Chop down'});for(let i=0;i<20;i++)core.TaskManager.process();assert.ok(f.p.getInventory().getAmount(core.ItemIdentifiers.LOGS)>0,'real chopping must yield logs');const n=f.p.getAttribute('pets:current');assert.equal(n?.getId(),npcId('skillpetwc'));assert.equal(n.getOwner(),f.p);assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpetwc')]);assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),0);
});
test('legacy Beaver active descriptor ignores obsolete NPC variant and survives actual save/login',async t=>{
 const f=actor(t);f.p.setAttribute('pets.owned',[item('skillpetwc')]);f.p.setAttribute('pets:active-item',item('skillpetwc'));f.p.setAttribute('pets:variant',{'skill:woodcutting':6717});PM.emitPlayerLogin({player:f.p,username:f.p.getUsername(),isNewAccount:false});const n=f.p.getAttribute('pets:current');assert.equal(n?.getId(),npcId('skillpetwc'));PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});const restored=g.p.getAttribute('pets:current');assert.equal(restored?.getId(),npcId('skillpetwc'));await action(g,restored,'Pick-up');assert.equal(g.p.getInventory().getAmount(item('skillpetwc')),1);
});
test('real Bank transfer and full-inventory pickup conserve the single Beaver item',async t=>{
 const f=actor(t),n=await summon(f);assert.equal(n.getId(),npcId('skillpetwc'));while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);await action(f,n,'Pick-up');assert.equal(f.p.getAttribute('pets:current'),n);f.p.getInventory().deleteAtSlot(27);await action(f,n,'Pick-up');f.p.getBank(0).open();core.Bank.deposit(f.p,item('skillpetwc'),f.p.getInventory().getSlotForItemId(item('skillpetwc')),1,false);assert.equal(f.p.getBank(0).getAmount(item('skillpetwc')),1);core.Bank.withdraw(f.p,item('skillpetwc'),f.p.getBank(0).getSlotForItemId(item('skillpetwc')),1,0);const restored=await drop(f,item('skillpetwc'));assert.equal(restored.getId(),npcId('skillpetwc'));await action(f,restored,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),1);
});
