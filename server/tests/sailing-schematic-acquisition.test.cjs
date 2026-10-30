const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
process.env.DISABLE_PLAYER_BOTS='1';
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
const rows = require('../plugins/skills/sailing/data/lost-schematics.json');
let core, next = 4700;
before(async () => {
 await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname,'..'));
 PluginManager.loadPluginSwitches = () => ({switches:new Map()});
 PluginManager.loadFromDirectory(path.resolve(__dirname,'../plugins'));
 core=PluginManager.getCoreApi(); core.RegionManager.init(); PluginManager.emitServerStartup({});
});
after(()=>PluginManager.emitServerShutdown({}));
function actor(t) {
 const p=new Player(null);p.setIndex(next++);p.setRegistered(true);p.setUsername('schematicqa'+p.getIndex());
 p.getSession=()=>({sendClientPacket:()=>true,write:()=>true});p.setHitpoints(10);
 p.sent={messages:[],objects:[],sounds:[],animations:[]};
 t.mock.method(p.getPacketSender(),'sendMessage',function(s){p.sent.messages.push(s);return this;});
 const sender=p.getPacketSender();
 for(const [name,key] of [['sendObject','objects'],['sendSoundEffect','sounds']]){
 const original=sender[name];t.mock.method(sender,name,function(...args){p.sent[key].push(args);return original.apply(this,args);});}
 const anim=p.performAnimation;t.mock.method(p,'performAnimation',function(a){p.sent.animations.push(a);return anim.call(this,a);});
 t.after(()=>{core.TaskManager.cancelTasks(p.getIndex());p.setRegistered(false);});return p;
}
const itemId=(gv)=>core.CacheDefinitions.getObjId(gv);
function give(p,id,slot=0){p.getInventory().setItem(slot,new core.Item(id,1));}
function dig(p) {
 const slot=p.getInventory().getItems().findIndex(i=>i.getId()===core.ItemIdentifiers.SPADE);
 return ClientConnection.prototype.inventoryAction.call({player:p},{type:'inventory_action',widgetId:core.CacheDefinitions.getComponentId('inventory:items'),slot,itemId:core.ItemIdentifiers.SPADE,option:'Dig'});
}
function box(row) {
 const pins={salvaging_station:[1883,3438],gale_catcher:[2472,2712],eternal_brazier:[2094,3667],dragon_salvaging_hook:[2106,3164],rosewood_cargo_hold:[1765,2652],dragon_cannon:[1945,2796],rosewood_hull:[1540,2790],rosewood_sail:[1938,4067],dragon_tiller:[2214,2332],dragon_keel:[2923,4086]};
 const [x,y]=pins[row.key];for(const dx of [-64,0,64])for(const dy of [-64,0,64])core.RegionManager.loadMapFiles(x+dx,y+dy);
 const o=[...MapObjects.mapObjects.values()].flat().find(o=>o.getId()===core.CacheDefinitions.getLocId(row.box.closed));assert.ok(o,row.key+' mapped lockbox');return o;
}
function open(p,row){const o=box(row);p.setLocation(o.getLocation().clone().add(0,-1));p.needsPlacement=false;const event={player:p,object:o,objectId:o.getId(),definition:core.ObjectDefinition.forPlayer(o.getId(),p),clickType:1,location:{x:o.getLocation().getX(),y:o.getLocation().getY(),z:o.getLocation().getZ()},handled:false};PluginManager.emitObjectInteraction(event);return event;}
const ticks=n=>{for(let i=0;i<n;i++)core.TaskManager.process();};
test('native Spade Dig awards the matching key without directions at each of ten Wiki tiles',(t)=>{for(const row of rows.filter(r=>r.box)){const p=actor(t);give(p,core.ItemIdentifiers.SPADE);p.setLocation(new core.Location(...row.box.dig));p.needsPlacement=false;dig(p);assert.equal(p.getInventory().getAmount(itemId(row.box.keyItem)),1,row.key);}});
test('mapped Lockbox Open without a key copies its own directions',(t)=>{for(const row of rows.filter(r=>r.box)){const p=actor(t);open(p,row);assert.equal(p.getInventory().getAmount(itemId(row.box.hintItem)),1,row.key);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),0);}});

test('first opening follows captured ticks and changes only the opening player view',(t)=>{
 const row=rows[0],p=actor(t),other=actor(t),id=itemId(row.box.keyItem),schematic=itemId(row.gameval);
 give(p,id);const o=box(row);open(p,row);open(p,row);
 assert.equal(p.getInventory().getAmount(id),1);ticks(1);
 assert.equal(p.getInventory().getAmount(id),0);assert.equal(p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId(row.box.unlocked)),1);
 assert.equal(p.getInventory().getAmount(schematic),0);ticks(1);
 assert.equal(p.sent.animations.at(-1).getId(),core.CacheDefinitions.getSeqId('human_openchest'));
 assert.equal(p.sent.animations.at(-1).getDelay(),10);assert.deepEqual(p.sent.sounds.slice(-2),[[2419,1,0],[52,1,10]]);
 ticks(1);assert.equal(p.getInventory().getAmount(schematic),1);assert.equal(p.sent.objects.at(-1)[0].getId(),core.CacheDefinitions.getLocId(row.box.open));assert.equal(other.sent.objects.length,0);
 assert.equal(MapObjects.get(o.getId(),o.getLocation(),null),o);ticks(2);assert.equal(p.sent.objects.at(-1)[0].getId(),o.getId());
});
test('exactly full inventory replaces the consumed key without losing unrelated items',(t)=>{
 const row=rows[0],p=actor(t);for(let i=0;i<28;i++)give(p,core.ItemIdentifiers.SPADE,i);give(p,itemId(row.box.keyItem),13);
 open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),1);assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.SPADE),27);
});
test('capacity taken after unlock leaves durable keyless reclaim and no lost unrelated item',(t)=>{
 const row=rows[0],p=actor(t);for(let i=0;i<28;i++)give(p,core.ItemIdentifiers.SPADE,i);give(p,itemId(row.box.keyItem),13);open(p,row);ticks(1);give(p,core.ItemIdentifiers.SPADE,13);ticks(2);
 assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.SPADE),28);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),0);
 p.getInventory().deleteNumber(core.ItemIdentifiers.SPADE,1);open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),1);
});
test('walking before the first tick retains key; interruption after unlock supports reclaim',(t)=>{
 const row=rows[0],p=actor(t);give(p,itemId(row.box.keyItem));open(p,row);core.TaskManager.cancelTasks(p.getIndex());ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.box.keyItem)),1);
 open(p,row);ticks(1);core.TaskManager.cancelTasks(p.getIndex());ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),0);assert.equal(p.getInventory().getAmount(itemId(row.box.keyItem)),0);
 open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),1);
});
test('death and logout never deliver a pending reward and retain permanent opened state',(t)=>{
 const row=rows[0];for(const how of ['death','logout']){const p=actor(t);give(p,itemId(row.box.keyItem));open(p,row);ticks(1);
 if(how==='death')p.setHitpoints(0);else p.setRegistered(false);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),0);
 assert.equal(p.getAttribute('sailing:schematics').opened.includes(row.key),true);}
});
test('held or banked schematic refuses the box and directions cannot multiply',(t)=>{
 const row=rows[0];for(const banked of [false,true]){const p=actor(t);if(banked)p.getBank(2).add(new core.Item(itemId(row.gameval),1),false);else give(p,itemId(row.gameval));open(p,row);
 assert.equal(p.getInventory().getAmount(itemId(row.box.hintItem)),0);assert.ok(p.sent.messages.includes("You've already got everything you can from this lockbox."));}
 const p=actor(t);open(p,row);p.getDialogueManager().reset();open(p,row);assert.equal(p.getInventory().getAmount(itemId(row.box.hintItem)),1);
});
test('duplicate key in another bank tab prevents repeat digging and full dig grants nothing',(t)=>{
 const row=rows[0],p=actor(t);give(p,core.ItemIdentifiers.SPADE);p.getBank(3).add(new core.Item(itemId(row.box.keyItem),1),false);p.setLocation(new core.Location(...row.box.dig));p.needsPlacement=false;dig(p);assert.equal(p.getInventory().getAmount(itemId(row.box.keyItem)),0);
 const full=actor(t);for(let i=0;i<28;i++)give(full,core.ItemIdentifiers.SPADE,i);full.setLocation(new core.Location(...row.box.dig));full.needsPlacement=false;dig(full);assert.equal(full.getInventory().getAmount(itemId(row.box.keyItem)),0);assert.equal(full.getInventory().getAmount(core.ItemIdentifiers.SPADE),28);
});
test('all ten mapped boxes accept only their own key and learn no recipe until Read',(t)=>{
 for(const row of rows.filter(r=>r.box)){const p=actor(t);give(p,itemId(row.box.keyItem));open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),1,row.key);assert.equal(p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId(row.learned)),0);}
 const p=actor(t),row=rows[0];give(p,itemId(rows[1].box.keyItem));open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(rows[1].box.keyItem)),1);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),0);assert.equal(p.getInventory().getAmount(itemId(row.box.hintItem)),1);
});
test('real bank deposit and withdrawal invalidate a waiting key then permit a fresh open',(t)=>{
 const p=actor(t),row=rows[0],id=itemId(row.box.keyItem);give(p,id);open(p,row);
 p.getBank(0).open();core.Bank.deposit(p,id,0,1,false);assert.equal(p.getInventory().getAmount(id),0);assert.equal(p.getBank(0).getAmount(id),1);ticks(1);
 core.Bank.withdraw(p,id,p.getBank(0).getSlotForItemId(id),1,0);assert.equal(p.getInventory().getAmount(id),1);p.getPacketSender().sendInterfaceRemoval();
 assert.equal(p.getInventory().getAmount(itemId(row.gameval)),0);open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),1);
});
test('opened state survives PlayerSave and reclaimed schematics stay logged once',(t)=>{
 const row=rows[0],p=actor(t);give(p,itemId(row.box.keyItem));open(p,row);ticks(1);
 const {PlayerSave}=require('../dist/game/entity/impl/player/persistence/PlayerSave');
 const save=PlayerSave.fromPlayer(p);core.TaskManager.cancelTasks(p.getIndex());
 const loaded=actor(t);save.applyToPlayer(loaded);loaded.setRegistered(true);loaded.needsPlacement=false;
 PluginManager.emitPlayerLogin({player:loaded,username:loaded.getUsername(),isNewAccount:false});
 assert.equal(loaded.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId(row.box.unlocked)),1);
 open(loaded,row);ticks(3);assert.equal(loaded.getInventory().getAmount(itemId(row.gameval)),1);
 assert.equal(loaded.getAttribute('clog.items')[itemId(row.gameval)],1);ticks(2);
 loaded.getInventory().deleteNumber(itemId(row.gameval),1);loaded.getPacketSender().sendInterfaceRemoval();
 open(loaded,row);ticks(3);assert.equal(loaded.getInventory().getAmount(itemId(row.gameval)),1);assert.equal(loaded.getAttribute('clog.items')[itemId(row.gameval)],1);
});
test('a matching metadata key consumes that slot and preserves the other physical copies',(t)=>{
 const row=rows[0],p=actor(t),id=itemId(row.box.keyItem);
 p.getInventory().setItem(4,new core.Item(id,1,{tag:'chosen'}));p.getInventory().setItem(10,new core.Item(id,1,{tag:'preserve'}));
 open(p,row);ticks(3);assert.equal(p.getInventory().getAmount(itemId(row.gameval)),1);
 assert.equal(p.getInventory().getItems()[10].getId(),id);assert.deepEqual(p.getInventory().getItems()[10].getMeta(),{tag:'preserve'});assert.equal(p.getInventory().getAmount(id),1);
});
