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
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('golemqa'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
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
async function summon(f,name='skillpetmining') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}




test('base Rock Golem native Drop uses normal world model and Pick-up returns its base item',async t=>{const f=actor(t),n=await summon(f);assert.equal(n.getId(),npcId('skillpet_mining_default'));assert.equal(n.getDefinition().getName(),'Rock Golem');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetmining')),1);});
test('actual copper Mining task awards the normal base Rock Golem',async t=>{
 const f=actor(t);f.p.getInventory().add(new core.Item(core.ItemIdentifiers.BRONZE_PICKAXE),true);const rock=new core.GameObject(core.CacheDefinitions.getLocId('copperrock1'),new core.Location(3223,3218,0),10,0,null);assert.ok(rock.getId()>0);core.ObjectManager.register(rock,true);t.after(()=>core.ObjectManager.deregister(rock,true));t.mock.method(Math,'random',()=>0);
 await send(f,{type:'object_option',id:rock.getId(),x:3223,y:3218,action:'Mine'});for(let i=0;i<20;i++)core.TaskManager.process();assert.ok(f.p.getInventory().getAmount(core.ItemIdentifiers.COPPER_ORE)>0,'actual mining must yield ore');const n=f.p.getAttribute('pets:current');assert.equal(n?.getId(),npcId('skillpet_mining_default'));assert.equal(n.getOwner(),f.p);assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpetmining')]);assert.equal(f.p.getInventory().getAmount(item('skillpetmining')),0);
});
for(const oldName of ['skillpet_mining_silver','poh_skillpet_mining_default'])test('legacy '+oldName+' active base item restores normal form after actual saved login',async t=>{const f=actor(t);f.p.setAttribute('pets.owned',[item('skillpetmining')]);f.p.setAttribute('pets:active-item',item('skillpetmining'));f.p.setAttribute('pets:variant',{'skill:mining':npcId(oldName)});PM.emitPlayerLogin({player:f.p,username:f.p.getUsername(),isNewAccount:false});assert.equal(f.p.getAttribute('pets:current')?.getId(),npcId('skillpet_mining_default'));const snapshot=PlayerSave.fromPlayer(f.p);PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);snapshot.applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});const n=g.p.getAttribute('pets:current');assert.equal(n?.getId(),npcId('skillpet_mining_default'));await action(g,n,'Pick-up');assert.equal(g.p.getInventory().getAmount(item('skillpetmining')),1);});

test('normal Rock Golem native Talk-to runs its normal mineral conversation through completion',async t=>{const f=actor(t),n=await summon(f);await action(f,n,'Talk-to');const lines=["So you're made entirely of rocks?","Not quite, my body is formed mostly of minerals.","Aren't minerals just rocks?","No, rocks are rocks, minerals are minerals. I am formed from minerals.","But you're a Rock Golem...","Yes, I am. This conversation seems to be confusing you; perhaps you should stop."];for(let i=0;i<lines.length;i++){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),lines[i]);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
