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
async function summon(f,name='skillpethunter_red') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}



const colours=["fire","air","mind","water","earth","body","cosmic","chaos","nature","law","death","soul","astral","blood","wrath"];

for(const colour of colours)test('native Drop/Pick-up preserves '+colour+' Rift guardian world and physical identity',async t=>{const f=actor(t),id=item('skillpetrunecrafting_'+colour),n=await summon(f,'skillpetrunecrafting_'+colour);assert.equal(n.getId(),npcId('skillpet_runecrafting_'+colour));await action(f,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(id),1);assert.equal(f.p.getAttribute('pets:current'),null);});
for(const colour of colours)test('actual Rune success boundary awards '+colour+' world guardian and one insured base family',t=>{const f=actor(t);t.mock.method(Math,'random',()=>0);PM.emitCustomEvent('runecrafting:success',{player:f.p,skill:core.Skill.RUNECRAFTING,runeId:core.ItemIdentifiers[colour.toUpperCase()+'_RUNE'],petBase:1795758,rolls:1});assert.equal(f.p.getAttribute('pets:current')?.getId(),npcId('skillpet_runecrafting_'+colour));assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpetrunecrafting_'+colour)]);assert.equal(f.p.getAttribute('clog.items')[item('skillpetrunecrafting_fire')],1);});
test('actual native Wrath altar binds essence, grants XP and awards the missing wrath form',async t=>{const f=actor(t);f.p.getSkillManager().setCurrentLevel(core.Skill.RUNECRAFTING,99);f.p.getSkillManager().setMaxLevel(core.Skill.RUNECRAFTING,99);f.p.getInventory().add(new core.Item(core.ItemIdentifiers.PURE_ESSENCE,2),true);const xp=f.p.getSkillManager().getExperience(core.Skill.RUNECRAFTING),id=core.ObjectIdentifiers.ALTAR_58,altar=new core.GameObject(id,new core.Location(3223,3218,0),10,0,null);assert.ok(id>0);core.ObjectManager.register(altar,true);t.after(()=>core.ObjectManager.deregister(altar,true));t.mock.method(Math,'random',()=>0);await send(f,{type:'object_option',id,x:3223,y:3218,action:'Craft-rune'});assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.PURE_ESSENCE),0);assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.WRATH_RUNE),2);assert.ok(f.p.getSkillManager().getExperience(core.Skill.RUNECRAFTING)>xp);assert.equal(f.p.getAttribute('pets:current')?.getId(),npcId('skillpet_runecrafting_wrath'));assert.deepEqual(f.p.getAttribute('pets.owned'),[item('skillpetrunecrafting_wrath')]);});
test('real Bank and active saved login preserve explicit Wrath rather than another family preference',async t=>{const f=actor(t),id=item('skillpetrunecrafting_wrath'),n=await summon(f,'skillpetrunecrafting_wrath');await action(f,n,'Pick-up');f.p.getBank(0).open();core.Bank.deposit(f.p,id,f.p.getInventory().getSlotForItemId(id),1,false);f.p.setAttribute('pets:variant',{'skill:runecrafting':npcId('poh_skillpet_runecrafting_air')});core.Bank.withdraw(f.p,id,f.p.getBank(0).getSlotForItemId(id),1,0);assert.equal((await drop(f,id)).getId(),npcId('skillpet_runecrafting_wrath'));const saved=PlayerSave.fromPlayer(f.p);PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);saved.applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});assert.equal(g.p.getAttribute('pets:current')?.getId(),npcId('skillpet_runecrafting_wrath'));assert.equal(g.p.getInventory().getAmount(id),0);});
test('last free slot and foreign pickup cannot duplicate the physical Wrath form',async t=>{const f=actor(t),g=actor(t),n=await summon(f,'skillpetrunecrafting_wrath');while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);await action(g,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getAttribute('pets:current'),n);f.p.getInventory().deleteAtSlot(27);await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetrunecrafting_wrath')),1);assert.equal(g.p.getInventory().getAmount(item('skillpetrunecrafting_wrath')),0);});
