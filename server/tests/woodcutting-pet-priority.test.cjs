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
// A nest takes the place of a roll's log, so the fixed draws below let the nest roll miss.
function missNest(value) {return ()=>new Error().stack.includes('maybeDropBirdNest')?0.99:value;}
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



test('native last-slot priority gives pet before resource when another follower is active',async t=>{
 const f=actor(t),beaver=item('skillpetwc');f.p.getInventory().add(new core.Item(core.ItemIdentifiers.OLMLET),true);const other=await drop(f,core.ItemIdentifiers.OLMLET);assert.ok(other?.isRegistered());f.p.getInventory().add(new core.Item(core.ItemIdentifiers.BRONZE_AXE),true);while(f.p.getInventory().getFreeSlots()>1)f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);
 const tree=new core.GameObject(core.ObjectIdentifiers.TREE,new core.Location(3223,3218,0),10,0,null);core.ObjectManager.register(tree,true);t.after(()=>core.ObjectManager.deregister(tree,true));t.mock.method(Math,'random',missNest(0));await send(f,{type:'object_option',id:tree.getId(),x:3223,y:3218,action:'Chop down'});for(let i=0;i<20;i++)core.TaskManager.process();
 assert.ok(f.p.getAttribute('pets.owned').includes(beaver),'controlled real chopping actually wins the pet');assert.equal(f.p.getInventory().getAmount(beaver),1,'Wiki pet-priority contract: last slot belongs to pet, not resource');assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),0,'resource must go to ground');const logs=core.World.getItems().filter(g=>g.getItem().getId()===core.ItemIdentifiers.LOGS&&g.getOwner()===f.p.getUsername());assert.equal(logs.reduce((n,g)=>n+g.getItem().getAmount(),0),1,'the displaced log must exist on the real ground');assert.equal(logs[0].getPrivateArea(),f.p.getPrivateArea());t.after(()=>{for(const g of logs)core.ItemOnGroundManager.deregister(g)});
});
async function chopOnce(t,f,random=0) {
 const tree=new core.GameObject(core.ObjectIdentifiers.TREE,new core.Location(3223,3218,0),10,0,null);
 core.ObjectManager.register(tree,true);t.after(()=>core.ObjectManager.deregister(tree,true));t.mock.method(Math,'random',missNest(random));
 const snapshots=[];PM.createApi('PetPriorityObserve'+f.p.getIndex()).onCustomEvent('woodcutting:success',e=>{if(e.player===f.p)snapshots.push({petRolled:e.petRolled,logs:f.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),pets:f.p.getInventory().getAmount(item('skillpetwc'))});});
 await send(f,{type:'object_option',id:tree.getId(),x:3223,y:3218,action:'Chop down'});for(let i=0;i<20;i++)core.TaskManager.process();return snapshots;
}
function axeAndSpace(f,free=1) {f.p.getInventory().add(new core.Item(core.ItemIdentifiers.BRONZE_AXE),true);while(f.p.getInventory().getFreeSlots()>free)f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);}
async function otherFollower(f) {f.p.getInventory().add(new core.Item(core.ItemIdentifiers.OLMLET),true);return drop(f,core.ItemIdentifiers.OLMLET);}
function groundLogs(f) {return core.World.getItems().filter(g=>g.getItem().getId()===core.ItemIdentifiers.LOGS&&g.getOwner()===f.p.getUsername());}

test('a missed pet roll leaves the ordinary last-slot log and postresource success event',async t=>{
 const f=actor(t),other=await otherFollower(f);axeAndSpace(f);const snapshots=await chopOnce(t,f,0.01);
 assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),1);assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),0);assert.equal(f.p.getAttribute('pets:current'),other);assert.equal(groundLogs(f).length,0);assert.deepEqual(snapshots,[{petRolled:true,logs:1,pets:0}]);
});
test('winning with no follower leaves the last slot for the log and saves only one active pet',async t=>{
 const f=actor(t);axeAndSpace(f);const snapshots=await chopOnce(t,f);assert.ok(f.p.getAttribute('pets:current')?.isRegistered());assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),0);assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),1);assert.equal(groundLogs(f).length,0);assert.deepEqual(snapshots,[{petRolled:true,logs:1,pets:0}]);
 PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});assert.ok(g.p.getAttribute('pets:current')?.isRegistered());assert.equal(g.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),1);assert.equal(g.p.getInventory().getAmount(item('skillpetwc')),0);
});
test('a duplicate family roll cannot consume the last resource slot or roll again on success',async t=>{
 const f=actor(t),other=await otherFollower(f);f.p.setAttribute('pets.owned',[core.ItemIdentifiers.OLMLET,item('skillpetwc')]);axeAndSpace(f);const messages=[];const sender=f.p.getPacketSender(),original=sender.sendMessage.bind(sender);t.mock.method(sender,'sendMessage',m=>{messages.push(m);return original(m)});
 const snapshots=await chopOnce(t,f);assert.equal(f.p.getAttribute('pets:current'),other);assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),1);assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),0);assert.equal(messages.filter(m=>m==='You have a funny feeling like you would have been followed...').length,1);assert.deepEqual(snapshots,[{petRolled:true,logs:1,pets:0}]);
});
test('an actual open log basket retains storage priority with a full pack and another follower',async t=>{
 const f=actor(t),other=await otherFollower(f),basket=new core.Item(core.ItemIdentifiers.OPEN_LOG_BASKET);f.p.getInventory().add(basket,true);axeAndSpace(f,0);await chopOnce(t,f);const contents={player:f.p,item:basket,contents:[],handled:false};PM.emitCustomEvent('storage:contents',contents);assert.equal(contents.handled,true);assert.ok(contents.contents.some(x=>x.id===core.ItemIdentifiers.LOGS&&x.amount>=1));assert.equal(f.p.getAttribute('pets:current'),other);assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),0);assert.ok(f.p.getAttribute('pets.owned').includes(item('skillpetwc')));assert.equal(groundLogs(f).length,0);
});

test('winning last-slot pet and displaced log survive real save, Bank deposit and native ground pickup',async t=>{
 const f=actor(t);await otherFollower(f);axeAndSpace(f);await chopOnce(t,f);const logs=groundLogs(f);assert.equal(logs.length,1);assert.equal(f.p.getInventory().getAmount(item('skillpetwc')),1);
 PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);g.p.setUsername(f.p.getUsername());PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});g.p.needsPlacement=false;assert.ok(g.p.getAttribute('pets:current')?.isRegistered());assert.equal(g.p.getInventory().getAmount(item('skillpetwc')),1);
 g.p.getBank(0).open();core.Bank.deposit(g.p,item('skillpetwc'),g.p.getInventory().getSlotForItemId(item('skillpetwc')),1,false);g.p.getPacketSender().sendInterfaceRemoval();await send(g,{type:'ground_item_action',itemId:core.ItemIdentifiers.LOGS,x:logs[0].getPosition().getX(),y:logs[0].getPosition().getY(),option:'Take',optionIndex:3});
 assert.equal(g.p.getBank(0).getAmount(item('skillpetwc')),1);assert.equal(g.p.getInventory().getAmount(core.ItemIdentifiers.LOGS),1);assert.equal(g.p.getInventory().getAmount(item('skillpetwc')),0);core.ItemOnGroundManager.process();assert.equal(core.World.getItems().includes(logs[0]),false);
});
