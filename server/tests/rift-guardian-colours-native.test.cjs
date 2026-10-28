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



const {MultiChatboxPrompt}=require('../dist/game/model/menu/MultiChatboxPrompt');
const text=f=>f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' ');
async function cont(f,group){await send(f,{type:'dialogue_continue',widgetId:(group<<16)|5,childIndex:-1});}
async function choose(f,index){await send(f,{type:'dialogue_continue',widgetId:(219<<16)|1,childIndex:index});}
async function colourDialogue(f,n){await action(f,n,'Locking');assert.equal(text(f),'About your colour-changing...');await cont(f,217);}
async function altar(t,f,name){const id=core.CacheDefinitions.getLocId(name),o=new core.GameObject(id,new core.Location(3223,3218,0),10,0,null);core.ObjectManager.register(o,true);t.after(()=>core.ObjectManager.deregister(o,true));f.p.getSkillManager().setCurrentLevel(core.Skill.RUNECRAFTING,99);f.p.getSkillManager().setMaxLevel(core.Skill.RUNECRAFTING,99);f.p.getInventory().add(new core.Item(core.ItemIdentifiers.PURE_ESSENCE,2),true);await send(f,{type:'object_option',id,x:3223,y:3218,action:'Craft-rune'});}
test('native actual Air altar recolours an owned Fire guardian and permanently unlocks Air once',async t=>{const f=actor(t),n=await summon(f);const xp=f.p.getSkillManager().getExperience(core.Skill.RUNECRAFTING);t.mock.method(Math,'random',()=>0.99);await altar(t,f,'air_altar');assert.equal(n.getId(),npcId('skillpet_runecrafting_air'));assert.equal(f.p.getAttribute('pets:active-item'),item('skillpetrunecrafting_air'));assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpetrunecrafting_air')]);assert.ok(f.p.getSkillManager().getExperience(core.Skill.RUNECRAFTING)>xp);assert.equal(f.p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId('skillpet_runecrafting_air_unlocked')),1);assert.ok(f.p.getAttribute('pets:rift-colours').includes('air'));});
test('native Locking canonical choices lock the current colour while actual Wrath altar still unlocks Wrath',async t=>{const f=actor(t),n=await summon(f);await colourDialogue(f,n);assert.match(text(f),/^If you take me to a Runecrafting Altar/);await cont(f,231);assert.ok(MultiChatboxPrompt.getPending(f.p));await choose(f,1);assert.equal(text(f),'I want you to stay this colour instead.');await cont(f,217);assert.match(text(f),/^Very well, I will remain locked/);assert.equal(f.p.getAttribute('pets:rift-locked'),true);await cont(f,231);t.mock.method(Math,'random',()=>0.99);await altar(t,f,'wrath_altar');assert.equal(n.getId(),npcId('skillpet_runecrafting_fire'));assert.ok(f.p.getAttribute('pets:rift-colours').includes('wrath'));await colourDialogue(f,n);assert.match(text(f),/^Even if you bind essence/);await cont(f,231);await choose(f,1);await cont(f,217);assert.equal(f.p.getAttribute('pets:rift-locked'),false);});
test('foreign and queued-removed Rift locking clicks cannot open an ownership dialogue',async t=>{const f=actor(t),g=actor(t),n=await summon(f);await action(g,n,'Locking');assert.equal(g.p.getDialogueManager().isActive(),false);await action(f,n,'Pick-up');await action(f,n,'Locking');assert.equal(f.p.getDialogueManager().isActive(),false);assert.notEqual(f.p.getAttribute('pets:rift-locked'),true);});
test('GOTR eligibility excludes altar recolours and unlocks as well as pet awards',async t=>{const f=actor(t),n=await summon(f);const Game=require('../plugins/minigames/guardiansoftherift/Game.GuardiansOfTheRift');Game.join(f.p);t.after(()=>Game.leave(f.p));PM.emitCustomEvent('runecrafting:success',{player:f.p,skill:core.Skill.RUNECRAFTING,runeId:core.ItemIdentifiers.AIR_RUNE,rolls:2,petBase:1795758});assert.equal(n.getId(),npcId('skillpet_runecrafting_fire'));assert.equal(f.p.getAttribute('pets:rift-colours')?.includes('air')??false,false);});
test('saved login restores lock/unlock varbits and exact physical colour for native Pick-up',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.99);await altar(t,f,'air_altar');f.p.setAttribute('pets:rift-locked',true);const save=PlayerSave.fromPlayer(f.p);PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);save.applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});const restored=g.p.getAttribute('pets:current');assert.equal(restored.getId(),npcId('skillpet_runecrafting_air'));assert.equal(g.p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId('skillpet_runecrafting_locked')),1);assert.equal(g.p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId('skillpet_runecrafting_air_unlocked')),1);await action(g,restored,'Pick-up');assert.equal(g.p.getInventory().getAmount(item('skillpetrunecrafting_air')),1);});
test('a native confirmation continued after the owner dies cannot commit a lock',async t=>{const f=actor(t),n=await summon(f);await colourDialogue(f,n);await cont(f,231);await choose(f,1);assert.equal(text(f),'I want you to stay this colour instead.');f.p.setHitpoints(0);await cont(f,217);assert.notEqual(f.p.getAttribute('pets:rift-locked'),true);});
test('a native confirmation cannot change locking during a trade',async t=>{const f=actor(t),n=await summon(f);await colourDialogue(f,n);await cont(f,231);await choose(f,1);f.p.setStatus(core.PlayerStatus.TRADING);await cont(f,217);assert.notEqual(f.p.getAttribute('pets:rift-locked'),true);f.p.setStatus(core.PlayerStatus.NONE);});
