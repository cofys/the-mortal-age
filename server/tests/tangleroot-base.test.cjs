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
  const p=new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('tanglerootqa'+next); p.setRegistered(true); p.setLocation(new core.Location(3222,3218,0)); p.needsPlacement=false;
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
async function summon(f,name='skillpetfarming') {const id=item(name);f.p.getInventory().add(new core.Item(id),true);const n=await drop(f,id);assert.ok(n?.isRegistered());return n;}





test('native Tangleroot Drop uses world definition and Pick-up conserves physical item',async t=>{const f=actor(t),n=await summon(f);assert.equal(n.getId(),npcId('skillpet_farming'));await action(f,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(item('skillpetfarming')),1);});
test('legacy house preference survives actual Bank and saved active login as world Tangleroot',async t=>{const f=actor(t),n=await summon(f);await action(f,n,'Pick-up');f.p.getBank(0).open();core.Bank.deposit(f.p,item('skillpetfarming'),f.p.getInventory().getSlotForItemId(item('skillpetfarming')),1,false);f.p.setAttribute('pets:variant',{'skill:farming':npcId('poh_skillpet_farming')});core.Bank.withdraw(f.p,item('skillpetfarming'),f.p.getBank(0).getSlotForItemId(item('skillpetfarming')),1,0);const first=await drop(f,item('skillpetfarming'));assert.equal(first.getId(),npcId('skillpet_farming'));const saved=PlayerSave.fromPlayer(f.p);PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);saved.applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});assert.equal(g.p.getAttribute('pets:current')?.getId(),npcId('skillpet_farming'));assert.equal(g.p.getInventory().getAmount(item('skillpetfarming')),0);});
test('native ordinary Tangleroot branch 1 excludes other form lines',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.03333333333333333);await action(f,n,'Talk-to');const expected=["How are you doing today?","I am Tangleroot!"];expected[1]??='I am '+f.p.getUsername()+'!';for(const[i,line]of expected.entries()){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),line);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
test('native ordinary Tangleroot branch 2 excludes other form lines',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.3666666666666667);await action(f,n,'Talk-to');const expected=["Hello there pretty plant.","I am Tangleroot!"];expected[1]??='I am '+f.p.getUsername()+'!';for(const[i,line]of expected.entries()){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),line);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
test('native ordinary Tangleroot branch 3 excludes other form lines',async t=>{const f=actor(t),n=await summon(f);t.mock.method(Math,'random',()=>0.7000000000000001);await action(f,n,'Talk-to');const expected=["I am Tangleroot!",null];expected[1]??='I am '+f.p.getUsername()+'!';for(const[i,line]of expected.entries()){assert.equal(f.p.getDialogueManager().getCurrent()?.getText?.()?.replace(/\s+/g,' '),line);await send(f,{type:'dialogue_continue',widgetId:((i%2===0?217:231)<<16)|5,childIndex:-1});}assert.equal(f.p.getDialogueManager().isActive(),false);});
test('normal current pet rejects all canonical alternate-form conditions without answering unrelated conditions',async t=>{const f=actor(t),n=await summon(f);const def=n.getCurrentDefinition(f.p);for(const label of ['Crystal','Dragonfruit','Herb','Redwood','White lily'])assert.equal(PM.emitNpcDialogueCondition({player:f.p,npc:n,npcId:n.getId(),definition:def,pages:[{page:'Tangleroot'}],text:label+' variant only:'}),false);assert.equal(PM.emitNpcDialogueCondition({player:f.p,npc:n,npcId:n.getId(),definition:def,pages:[{page:'Tangleroot'}],text:'A condition that belongs to another plugin:'}),null);});
