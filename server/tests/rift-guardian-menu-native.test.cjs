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
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('riftform'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
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
async function summon(f,name='skillpetrunecrafting_fire') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}



const MENU='menu:lj_layer1';
async function pick(f,slot){await send(f,{type:'dialogue_continue',widgetId:core.CacheDefinitions.getComponentId(MENU),childIndex:slot});}
function captureScripts(t,f){const scripts=[],sender=f.p.getPacketSender(),original=sender.sendClientScript;t.mock.method(sender,'sendClientScript',function(...args){scripts.push(args);return original.apply(this,args);});return scripts;}
test('native normal Metamorphosis opens its cache parchment with only the current unlocked form and no talisman',async t=>{const f=actor(t),n=await summon(f),scripts=captureScripts(t,f);await action(f,n,'Metamorphosis');assert.equal(f.p.getInterfaceId(),core.CacheDefinitions.getInterfaceId('menu'));const script=scripts.find(args=>args[0]===217);assert.ok(script);assert.equal(script[2],'Choose metamorph');assert.equal(script[3],'Fire altar');await pick(f,0);assert.equal(n.getId(),npcId('skillpet_runecrafting_fire'));assert.notEqual(f.p.getInterfaceId(),core.CacheDefinitions.getInterfaceId('menu'));assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.FIRE_TALISMAN),0);});
test('native chooser selects learned colours in Wiki order and pickup returns the selected physical item',async t=>{const f=actor(t),n=await summon(f),scripts=captureScripts(t,f);f.p.setAttribute('pets:rift-colours',['fire','air']);await action(f,n,'Metamorphosis');assert.equal(scripts.find(args=>args[0]===217)?.[3],'Air altar|Fire altar');await pick(f,0);assert.equal(n.getId(),npcId('skillpet_runecrafting_air'));assert.equal(f.p.getAttribute('pets:active-item'),item('skillpetrunecrafting_air'));assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpetrunecrafting_air')]);assert.equal(f.p.getAttribute('pets:variant')['skill:runecrafting'],npcId('skillpet_runecrafting_air'));assert.equal(f.p.getAttribute('clog.items')[item('skillpetrunecrafting_fire')],1);await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetrunecrafting_air')),1);assert.equal(f.p.getInventory().getAmount(item('skillpetrunecrafting_fire')),0);});
test('forged locked/out-of-range choice and repeated stale picks cannot select an unlearned form',async t=>{const f=actor(t),n=await summon(f);await action(f,n,'Metamorphosis');await pick(f,1);await pick(f,0);assert.equal(n.getId(),npcId('skillpet_runecrafting_fire'));assert.equal(f.p.getAttribute('pets:rift-colours').includes('air'),false);});
test('native close invalidates chooser selection before it can mutate the follower',async t=>{const f=actor(t),n=await summon(f);f.p.setAttribute('pets:rift-colours',['fire','air']);await action(f,n,'Metamorphosis');await send(f,{type:'interface_close'});await pick(f,0);assert.equal(n.getId(),npcId('skillpet_runecrafting_fire'));});
test('Wrath has a working native chooser despite having no legacy cycle destination',async t=>{const f=actor(t),n=await summon(f,'skillpetrunecrafting_wrath'),scripts=captureScripts(t,f);await action(f,n,'Metamorphosis');assert.equal(f.p.getInterfaceId(),core.CacheDefinitions.getInterfaceId('menu'));assert.equal(scripts.find(args=>args[0]===217)?.[3],'Wrath altar');});
test('native picker continued after death or entering trade cannot mutate the chosen form',async t=>{for(const condition of ['death','trade']){const f=actor(t),n=await summon(f);f.p.setAttribute('pets:rift-colours',['fire','air']);await action(f,n,'Metamorphosis');if(condition==='death')f.p.setHitpoints(0);else f.p.setStatus(core.PlayerStatus.TRADING);await pick(f,0);assert.equal(n.getId(),npcId('skillpet_runecrafting_fire'));f.p.setStatus(core.PlayerStatus.NONE);}});
