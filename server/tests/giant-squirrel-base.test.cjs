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
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('squirrelqa'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
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
async function summon(f,name='skillpetagility') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}




test('native base squirrel Drop uses the world follower and Pick-up conserves item',async t=>{const f=actor(t),n=await summon(f);assert.equal(n.getId(),npcId('skillpet_agility'));assert.equal(n.getDefinition().getName(),'Giant Squirrel');await action(f,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetagility')),1);});
test('legacy POH follower preference restores world squirrel through actual save/login',async t=>{const f=actor(t);f.p.setAttribute('pets.owned',[item('skillpetagility')]);f.p.setAttribute('pets:active-item',item('skillpetagility'));f.p.setAttribute('pets:variant',{'skill:agility':npcId('poh_skillpet_agility')});PM.emitPlayerLogin({player:f.p,username:f.p.getUsername(),isNewAccount:false});assert.equal(f.p.getAttribute('pets:current')?.getId(),npcId('skillpet_agility'));const snapshot=PlayerSave.fromPlayer(f.p);PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);snapshot.applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});const n=g.p.getAttribute('pets:current');assert.equal(n?.getId(),npcId('skillpet_agility'));await action(g,n,'Pick-up');assert.equal(g.p.getInventory().getAmount(item('skillpetagility')),1);});
test('actual Bank deposit/withdraw preserves squirrel while another pet is preferred',async t=>{const f=actor(t),n=await summon(f);await action(f,n,'Pick-up');f.p.getBank(0).open();core.Bank.deposit(f.p,item('skillpetagility'),f.p.getInventory().getSlotForItemId(item('skillpetagility')),1,false);assert.equal(f.p.getBank(0).getAmount(item('skillpetagility')),1);f.p.setAttribute('pets:variant',{'skill:agility':npcId('poh_skillpet_agility')});core.Bank.withdraw(f.p,item('skillpetagility'),f.p.getBank(0).getSlotForItemId(item('skillpetagility')),1,0);assert.equal((await drop(f,item('skillpetagility'))).getId(),npcId('skillpet_agility'));});
test('foreign pickup and full backpack retain the owned world squirrel',async t=>{const f=actor(t),g=actor(t),n=await summon(f);await action(g,n,'Pick-up');assert.equal(g.p.getInventory().getAmount(item('skillpetagility')),0);while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);await action(f,n,'Pick-up');assert.equal(f.p.getAttribute('pets:current'),n);f.p.getInventory().deleteAtSlot(27);await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetagility')),1);});
test('native ordinary squirrel conversation 1 finishes',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.03333333333333333);await action(f,n,'Talk-to');for(const [i,line]of ["So how come you are so agile?","If you were so nutty about nuts, maybe you would understand the great lengths we go to!"].entries()){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),line);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
test('native ordinary squirrel conversation 2 finishes',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.3666666666666667);await action(f,n,'Talk-to');for(const [i,line]of ["What's up with all that squirrel fur? I guess fleas need a home too.","You're pushing your luck! Stop it or you'll face my squirrely wrath."].entries()){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),line);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
test('native ordinary squirrel conversation 3 finishes',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.7000000000000001);await action(f,n,'Talk-to');for(const [i,line]of ["Did you ever notice how big squirrels' teeth are?","No...","You could land a gnome glider on those things!","Watch it, I'll crush your nuts!"].entries()){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),line);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
