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

function fixture(t) {
 const transport={kind:'test',remoteAddress:'127.0.0.1',isOpen:()=>true,send:()=>true,close(){},onData(){},onError(){},onClose(){}};
 const p=new Player(new PlayerSession(transport));p.setIndex(index++);p.setUsername('nature'+index);p.setRegistered(true);p.setAttribute('bot-skip-persistence',true);
 p.setLocation(new core.Location(3200,3200,0));
 const patch=Data.CACHE.patches.find(p=>p.type==='HERB'&&p.x===3058)||Data.CACHE.patches.find(p=>p.type==='HERB');
 const state=Patches.stateFor(p,patch),farm=Patches.farmFor(p),crop=Data.CROPS.get('GUAM');
 Object.assign(state,{crop:crop.key,status:'growing',stage:crop.stages-1,protected:true,nextAt:Date.now()-1000});
 farm.boundPatch=Data.patchKey(patch);farm.boundStatus='growing';
 const id=Data.itemId('Amulet of Nature');p.getInventory().add(new core.Item(id));
 const connection=new ClientConnection(transport);connection.player=p;const messages=[];
 t.mock.method(p.getPacketSender(),'sendMessage',m=>{messages.push(m);return p.getPacketSender();});
 t.after(()=>{PM.emitPlayerLogout({player:p,username:p.getUsername()});core.TaskManager.cancelTasks(p);p.setRegistered(false);});
 return {p,patch,state,farm,crop,id,connection,messages};
}
async function rub(f){await f.connection.dispatch([{type:'inventory_action',widgetId:core.Inventory.INTERFACE_ID,slot:0,itemId:f.id,option:'Rub',optionIndex:1}]);f.connection.processTurnPackets();}
test('native Rub advances a due crop before reporting and preserves notification ownership',async t=>{
 const f=fixture(t);await rub(f);assert.equal(f.state.status,'grown');assert.ok(f.messages.some(m=>m.includes('grown')));assert.equal(f.farm.boundStatus,'growing');
 const after=JSON.stringify(f.state);await rub(f);assert.equal(JSON.stringify(f.state),after);assert.equal(f.p.getInventory().getAmount(f.id),1);
});
test('native Rub reports death after a due diseased cycle',async t=>{
 const f=fixture(t);f.state.status='diseased';await rub(f);assert.equal(f.state.status,'dead');assert.ok(f.messages.some(m=>m.includes('dead')));
});
test('Rub does not advance a future cycle and unbound Rub does not mutate crops',async t=>{
 const f=fixture(t);f.state.nextAt=Date.now()+60000;const before=JSON.stringify(f.state);await rub(f);assert.equal(JSON.stringify(f.state),before);
 const g=fixture(t);delete g.farm.boundPatch;const initial=JSON.stringify(g.state);await rub(g);assert.equal(JSON.stringify(g.state),initial);assert.ok(g.messages.some(m=>m.includes('bind')));
});

test('native worn Rub uses equipment operation and Remove still removes',async t=>{
 const f=fixture(t);
 await f.connection.dispatch([{type:'inventory_action',widgetId:core.Inventory.INTERFACE_ID,slot:0,itemId:f.id,option:'Wear'}]);f.connection.processTurnPackets();
 assert.equal(f.p.getEquipment().forSlot(core.Equipment.AMULET_SLOT).getId(),f.id);
 await f.connection.dispatch([{type:'widget_action',widgetId:(387<<16)|17,groupId:387,childId:17,buttonNum:2,itemId:f.id,slot:-1}]);f.connection.processTurnPackets();
 assert.equal(f.state.status,'grown');assert.ok(f.messages.some(m=>m.includes('grown')));assert.equal(f.p.getEquipment().forSlot(core.Equipment.AMULET_SLOT).getId(),f.id);
 await f.connection.dispatch([{type:'widget_action',widgetId:(387<<16)|17,groupId:387,childId:17,buttonNum:1,itemId:f.id,slot:-1}]);f.connection.processTurnPackets();
 assert.equal(f.p.getInventory().getAmount(f.id),1);
});
