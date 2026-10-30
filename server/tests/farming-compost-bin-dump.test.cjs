// Real map objects, players, containers, Farming work and native object packets; network only is stubbed.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
process.env.DISABLE_PLAYER_BOTS = '1';
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
let core, Data, Patches, index = 1700;
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname,'..'));
  PM.loadFromDirectory(path.resolve(__dirname,'../plugins')); core = PM.getCoreApi();
  core.RegionManager.init();
  Data = require('../plugins/skills/farming/Data.Farming');
  Patches = require('../plugins/skills/farming/Patches.Farming');
  PM.emitServerStartup({});
  core.RegionManager.loadMapFiles(3056,3312); core.RegionManager.loadMapFiles(1272,3729);
});
function fixture(t, type = 'COMPOST', count = 3, tier = 4) {
  const transport = { kind:'test',remoteAddress:'127.0.0.1',isOpen:()=>true,send:()=>true,
    close(){},onData(){},onError(){},onClose(){} };
  const p = new Player(new PlayerSession(transport));
  p.setIndex(index++); p.setUsername('dumpbin' + index); p.setRegistered(true);
  p.setAttribute('bot-skip-persistence',true);
  p.getSkillManager().setMaxLevels(core.Skill.FARMING,99,false).setCurrentLevels(core.Skill.FARMING,99,false);
  const patch = Data.CACHE.patches.find(p => p.type === type && (type === 'BIG_COMPOST' || p.x === 3056));
  p.setLocation(new core.Location(patch.x - 1,patch.y,patch.z));
  const state = Patches.stateFor(p,patch);
  state.bin = { count,super:0,tomatoes:tier === 4 ? count : 0,tier,closedAt:1,open:true };
  Patches.syncPatch(p,patch);
  const connection = new ClientConnection(transport); connection.player=p;
  const messages=[];
  t.mock.method(p.getPacketSender(),'sendMessage',text=>{messages.push(text);return p.getPacketSender();});
  t.after(()=>{PM.emitPlayerLogout({player:p,username:p.getUsername()});core.TaskManager.cancelTasks(p);p.setRegistered(false);});
  return {p,patch,state,bin:state.bin,connection,messages,inv:p.getInventory(),xp:p.getSkillManager().getExperience(core.Skill.FARMING)};
}
async function input(f,packet) {
  await f.connection.dispatch([packet]); f.connection.processTurnPackets();
  f.p.getMovementQueue().process(); core.TaskManager.processWalkTo(f.p.getIndex());
}
async function dump(f) {
  assert.equal(core.ObjectDefinition.forPlayer(f.patch.id,f.p).getInteractions()[4],'Dump');
  await input(f,{type:'object_option',id:f.patch.id,x:f.patch.x,y:f.patch.y,action:'Dump'});
  assert.ok(f.p.getDialogueManager().getCurrent() instanceof core.OptionDialogue,'Dump presents a confirmation');
}
async function answer(f,childIndex=1) {
  await input(f,{type:'dialogue_continue',widgetId:core.OptionDialogue.OPTIONS_WIDGET_ID,childIndex});
}
test('native Dump confirms before discarding either bin size at each accessible stage without rewards',async t=>{
  for(const type of ['COMPOST','BIG_COMPOST']) for(const stage of ['filling','rotting','ready','open']) {
    const f=fixture(t,type,type==='BIG_COMPOST'?30:15,2);
    Object.assign(f.bin,{open:stage==='open',closedAt:stage==='filling'?0:stage==='rotting'?Date.now():1});
    Patches.syncPatch(f.p,f.patch);
    const before=JSON.stringify(f.bin);await dump(f);assert.equal(JSON.stringify(f.state.bin),before);
    await answer(f);assert.equal(f.state.bin.count,0);assert.equal(f.state.bin.open,false);
    assert.equal(f.p.getPacketSender().getVarbit(f.patch.varbit),0);
    assert.equal(f.inv.getFreeSlots(),28);assert.equal(f.p.getSkillManager().getExperience(core.Skill.FARMING),f.xp);
  }
});
test('No preserves contents; repeated confirmation cannot discard subsequently refilled contents',async t=>{
  const f=fixture(t);await dump(f);await answer(f,2);assert.equal(f.state.bin.count,3);
  // No world loop runs in this fixture: explicitly expire the tick-based input gate.
  f.p.getClickDelay().reset(-100);
  await dump(f);await answer(f);f.state.bin.count=2;await answer(f);assert.equal(f.state.bin.count,2);
});
test('a changed or replaced bin invalidates the pending confirmation',async t=>{
  for(const replace of [false,true]) {
    const f=fixture(t);await dump(f);
    if(replace) f.state.bin={...f.bin}; else f.bin.count=2;
    const before=JSON.stringify(f.state.bin);await answer(f);assert.equal(JSON.stringify(f.state.bin),before);
  }
});
test('native walking and interface removal cancel Dump; logout cannot discard contents',async t=>{
  for(const interrupt of ['walk','close','logout']) {
    const f=fixture(t);await dump(f);
    if(interrupt==='walk') {
      await input(f,{type:'move',worldX:f.patch.x-1,worldY:f.patch.y+1,modifierFlags:0});
      assert.equal(f.p.getLocation().getY(),f.patch.y+1,'native walking reached its destination');
    }
    if(interrupt==='close') f.p.getPacketSender().sendInterfaceRemoval();
    if(interrupt==='logout') {PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});f.p.setRegistered(false);}
    await answer(f);assert.equal(f.state.bin.count,3,interrupt);
  }
});
test('Dump affects only the selected bin and its owner',async t=>{
  const f=fixture(t),g=fixture(t);
  const other=Data.CACHE.patches.find(p=>p.type==='COMPOST'&&p.x!==f.patch.x);
  Patches.stateFor(f.p,other).bin={...f.bin};
  await dump(f);await answer(f);
  assert.equal(f.state.bin.count,0);assert.equal(g.state.bin.count,3);assert.equal(Patches.stateFor(f.p,other).bin.count,3);
});

