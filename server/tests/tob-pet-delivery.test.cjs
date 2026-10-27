const assert=require("node:assert/strict");
const path=require("node:path");
const {before,after,test}=require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const {CachePipeline}=require("../dist/game/cache/CachePipeline");
const {PluginManager:PM}=require("../dist/plugins/PluginManager");
const {Player}=require("../dist/game/entity/impl/player/Player");
const {PlayerSession}=require("../dist/net/PlayerSession");
const {ClientConnection}=require("../dist/net/NetworkBuilder");
let core,Raid,Parties,Rewards,Shared,next=900;
before(async()=>{
  await CachePipeline.initialize(path.resolve(__dirname,".."));PM.loadFromDirectory(path.resolve(__dirname,"../plugins"));core=PM.getCoreApi();
  core.RegionManager.init();core.RegionManager.loadMapFiles(3233,4330);core.RegionManager.loadMapFiles(3667,3219);PM.emitServerStartup({});
  Raid=require("../plugins/minigames/tob/RaidState.TheatreOfBlood");Parties=require("../plugins/minigames/tob/Parties.TheatreOfBlood");Rewards=require("../plugins/minigames/tob/Rewards.TheatreOfBlood");Shared=require("../plugins/minigames/tob/Shared.TheatreOfBlood");
});
after(()=>PM.emitServerShutdown({}));
function actor(t){
  const channel={kind:"test",remoteAddress:"127.0.0.1",isOpen:()=>true,send:()=>true,close(){},onData(){},onError(){},onClose(){}};
  const p=new Player(new PlayerSession(channel));p.setIndex(next++);p.setUsername("zikqa"+next);p.setRegistered(true);p.setLocation(new core.Location(3667,3219,0));p.needsPlacement=false;
  const c=new ClientConnection(channel);c.player=p;const messages=[];t.mock.method(p.getPacketSender(),"sendMessage",m=>{messages.push(m);return p.getPacketSender();});
  t.after(()=>{PM.emitPlayerLogout({player:p,username:p.getUsername()});p.setRegistered(false);core.TaskManager.cancelTasks(p.getIndex());for(const npc of [...core.World.getNpcs()])if(npc?.getOwner?.()===p)core.World.getNpcs().remove(npc);});
  return {p,c,messages};
}
function vault(t,group){
  const party=Parties.create(group[0].p);for(const f of group.slice(1)){party.apply(f.p);assert.equal(party.accept(f.p),true);}
  const raid=new Raid.Raid(party);for(const f of group)raid.member(f.p).roomStats("VERZIK").damage=100;
  t.mock.method(Math,"random",()=>0);const room=raid.buildRoom("REWARDS");
  for(const f of group){raid.arrive(f.p,room);f.p.needsPlacement=false;f.p.getPacketSender().sendInterfaceRemoval();}
  t.after(()=>{if(Raid.raids.has(raid.id))raid.dispose();});return {raid,room};
}
const pet=()=>core.ItemIdentifiers.LIL_ZIK;
const owned=f=>(f.p.getAttribute("pets.owned")??[]).includes(pet());
const pending=f=>Rewards.lootOf(f.p).some(x=>x.id===pet());
function follow(t,f){PM.emitCustomEvent("npc-drops:roll",{player:f.p,drops:[{itemId:core.ItemIdentifiers.HELLPUPPY,amount:1}]});const n=f.p.getAttribute("pets:current");assert.ok(n?.isRegistered());return n;}
async function open(f,room,slot=0){
  const chest=room.chests[slot],at=chest.getLocation();f.p.setLocation(new core.Location(at.getX(),at.getY()-1,at.getZ()));f.p.needsPlacement=false;
  await f.c.dispatch([{type:"object_option",id:chest.getId(),x:at.getX(),y:at.getY(),clickType:1,action:"Open"}]);f.c.processTurnPackets();
  for(let i=0;i<8;i++){core.TaskManager.processWalkTo(f.p.getIndex());f.p.getMovementQueue().process();core.TaskManager.process();}
}
async function button(f,name){const uid=core.CacheDefinitions.getComponentId("tob_chests:"+name);await f.c.dispatch([{type:"widget_action",widgetId:uid,groupId:uid>>>16,childId:uid&65535,buttonNum:1,slot:0}]);f.c.processTurnPackets();}
async function outsideClaim(t,f){
  f.p.setLocation(new core.Location(3677,3217,0));f.p.needsPlacement=false;f.p.getPacketSender().sendInterfaceRemoval();
  const object=new core.GameObject(core.CacheDefinitions.getLocId("tob_rewards_chest_lobby_multi"),new core.Location(3678,3217,0),10,0);
  core.ObjectManager.register(object,true);t.after(()=>core.ObjectManager.deregister(object,true));
  const display=core.ObjectDefinition.forPlayer(object.getId(),f.p).id;
  await f.c.dispatch([{type:"object_option",id:display,x:3678,y:3217,clickType:1,action:"Search"}]);f.c.processTurnPackets();
  for(let i=0;i<8;i++){core.TaskManager.processWalkTo(f.p.getIndex());f.p.getMovementQueue().process();core.TaskManager.process();}
}

test("a real generated vault roll follows on native own-chest Open, records ownership and leaves no pet loot",async t=>{
  const f=actor(t),v=vault(t,[f]);assert.equal(pending(f),true);assert.equal(owned(f),false);await open(f,v.room);
  assert.equal(owned(f),true,JSON.stringify({opened:[...v.room.opened],interface:f.p.getInterfaceId(),loot:Rewards.lootOf(f.p),messages:f.messages,location:f.p.getLocation()}));assert.equal(pending(f),false);const follower=f.p.getAttribute("pets:current");assert.ok(follower?.isRegistered());assert.equal(follower.getId(),core.CacheDefinitions.getNpcId("verzik_pet"));assert.equal(follower.getOwner(),f.p);assert.equal(f.p.getAttribute("clog.items")[pet()],1);
});
test("an existing follower sends Lil' Zik into the real backpack once",async t=>{
  const f=actor(t),existing=follow(t,f),v=vault(t,[f]);await open(f,v.room);assert.equal(owned(f),true);assert.equal(f.p.getAttribute("pets:current"),existing);assert.equal(f.p.getInventory().getAmount(pet()),1);assert.equal(pending(f),false);
  await button(f,"inventory");await button(f,"inventory");assert.equal(f.p.getInventory().getAmount(pet()),1);
});
test("full backpack and follower retain insurance without placing another item in chest or ground",async t=>{
  const f=actor(t),existing=follow(t,f),v=vault(t,[f]);while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);
  await open(f,v.room);assert.equal(owned(f),true);assert.equal(pending(f),false);assert.equal(f.p.getInventory().getAmount(pet()),0);assert.equal(f.p.getAttribute("pets:current"),existing);assert.ok(f.messages.some(m=>m.includes("Probita")));
});
test("foreign chest cannot consume another member's rolled pet",async t=>{
  const a=actor(t),b=actor(t),v=vault(t,[a,b]);await open(a,v.room,1);assert.equal(owned(a),false);assert.equal(owned(b),false);assert.equal(pending(a),true);assert.equal(pending(b),true);
  await open(a,v.room,0);assert.equal(owned(a),true);assert.equal(owned(b),false);
});
test("real bank-all still transfers ordinary loot but cannot bank or duplicate the pet",async t=>{
  const f=actor(t);follow(t,f);const v=vault(t,[f]);await open(f,v.room);const ordinary=Rewards.lootOf(f.p).filter(x=>x.id!==pet()).map(x=>({...x}));assert.ok(ordinary.length);
  await button(f,"bank");assert.equal(pending(f),false);assert.equal(f.p.getBank(0).getAmount(pet()),0);assert.equal(f.p.getInventory().getAmount(pet()),1);for(const entry of ordinary)assert.equal(f.p.getBanks().reduce((n,b)=>n+b.getAmount(entry.id),0),entry.amount);
});
test("reopening and native claims respect pet ownership after a real bank deposit/withdraw round trip",async t=>{
  const f=actor(t);follow(t,f);const v=vault(t,[f]);await open(f,v.room);assert.equal(owned(f),true);
  f.p.getPacketSender().sendInterfaceRemoval();const inv=f.p.getInventory(),slot=inv.getSlotForItemId(pet());f.p.getBank(0).open();core.Bank.deposit(f.p,pet(),slot,1,false);const tab=core.Bank.getTabForItem(f.p,pet());core.Bank.withdraw(f.p,pet(),f.p.getBank(tab).getSlotForItemId(pet()),1,tab);f.p.getPacketSender().sendInterfaceRemoval();assert.equal(inv.getAmount(pet()),1);
  await open(f,v.room);await button(f,"inventory");assert.equal(inv.getAmount(pet()),1);assert.equal(pending(f),false);
});
test("a fresh Player restores a real pending ownership-save snapshot without another pet award",async t=>{
  const f=actor(t);follow(t,f);const v=vault(t,[f]),{PlayerSave}=require("../dist/game/entity/impl/player/persistence/PlayerSave");let saved;
  const emit=PM.emitCustomEvent.bind(PM);t.mock.method(PM,"emitCustomEvent",(name,event)=>{if(name==="persistence:save"&&event.player===f.p&&event.reason==="pet-insurance"&&owned(f))saved=PlayerSave.fromPlayer(f.p);return emit(name,event);});
  await open(f,v.room);assert.ok(saved);const g=actor(t);saved.applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});g.p.needsPlacement=false;assert.equal(owned(g),true);assert.equal(pending(g),true);
  await outsideClaim(t,g);assert.equal(pending(g),false);assert.equal(g.p.getInventory().getAmount(pet()),0);assert.equal(owned(g),true);assert.equal(g.p.getAttribute("clog.items")[pet()],1);
});
test("a full backpack without a follower still receives the earned pet as a follower",async t=>{
  const f=actor(t),v=vault(t,[f]);while(f.p.getInventory().getFreeSlots())f.p.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE),false);await open(f,v.room);
  assert.equal(owned(f),true);assert.equal(pending(f),false);assert.equal(f.p.getInventory().getAmount(pet()),0);assert.equal(f.p.getAttribute("pets:current").getId(),core.CacheDefinitions.getNpcId("verzik_pet"));
});
