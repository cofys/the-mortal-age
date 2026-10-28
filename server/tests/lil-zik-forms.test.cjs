const assert=require('node:assert/strict'),path=require('node:path');
const {before,after,test}=require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const {CachePipeline}=require('../dist/game/cache/CachePipeline'),{PluginManager:PM}=require('../dist/plugins/PluginManager');
const {Player}=require('../dist/game/entity/impl/player/Player'),{PlayerSession}=require('../dist/net/PlayerSession'),{ClientConnection}=require('../dist/net/NetworkBuilder');
const {PlayerSave}=require('../dist/game/entity/impl/player/persistence/PlayerSave');
let core,House,MaxHouse,ConstructionData,next=1550;
const forms=[['verzikpet','verzik_pet'],['maidenpet','verzik_pet_maiden'],['bloatpet','verzik_pet_bloat'],['nylocaspet','verzik_pet_nylocas'],['sotetsegpet','verzik_pet_sotetseg'],['xarpuspet','verzik_pet_xarpus']];
const refusal='You need to earn sanguine dust from the Theatre of Blood Challenge Mode to do that.';
const obj=name=>core.CacheDefinitions.getObjId(name),npc=name=>core.CacheDefinitions.getNpcId(name);
before(async()=>{await CachePipeline.initialize(path.resolve(__dirname,'..'));PM.loadFromDirectory(path.resolve(__dirname,'../plugins'));core=PM.getCoreApi();core.RegionManager.init();core.RegionManager.loadMapFiles(3222,3218);core.RegionManager.loadMapFiles(2611,3295);PM.emitServerStartup({});House=require('../plugins/skills/construction/House.Construction');MaxHouse=require('../plugins/skills/construction/MaxHouse.Construction');ConstructionData=require('../plugins/skills/construction/Data.Construction');});
after(()=>PM.emitServerShutdown({}));
function actor(t){
  const channel={kind:'test',remoteAddress:'127.0.0.1',isOpen:()=>true,send:()=>true,close(){},onData(){},onError(){},onClose(){}};
  const p=new Player(new PlayerSession(channel));p.setIndex(next++);p.setUsername('zikforms'+next);p.setRegistered(true);p.setLocation(new core.Location(3222,3218,0));p.needsPlacement=false;
  const c=new ClientConnection(channel);c.player=p;const messages=[];t.mock.method(p.getPacketSender(),'sendMessage',m=>{messages.push(m);return p.getPacketSender();});
  t.after(()=>{if(House.houseFor(p))House.releaseHouse(p,true);PM.emitPlayerLogout({player:p,username:p.getUsername()});p.setRegistered(false);core.TaskManager.cancelTasks(p.getIndex());for(const n of [...core.World.getNpcs()])if(n?.getOwner?.()===p)core.World.getNpcs().remove(n);});
  return{p,c,messages};
}
async function drain(f){for(let i=0;i<10;i++){core.TaskManager.processWalkTo(f.p.getIndex());f.p.getMovementQueue().process();core.TaskManager.process();}}
async function send(f,message){await f.c.dispatch([message]);f.c.processTurnPackets();await drain(f);}
function give(f,id,amount=1){f.p.getInventory().add(new core.Item(id,amount),true);return f.p.getInventory().getSlotForItemId(id);}
async function drop(f,id){f.p.getPacketSender().sendInterfaceRemoval();await send(f,{type:'inventory_action',itemId:id,slot:f.p.getInventory().getSlotForItemId(id),widgetId:149<<16,option:'Drop',optionIndex:5});return f.p.getAttribute('pets:current');}
async function summon(f,name='verzikpet'){give(f,obj(name));const n=await drop(f,obj(name));assert.ok(n?.isRegistered());return n;}
async function action(f,n,name){f.p.getPacketSender().sendInterfaceRemoval();n.setLocation(new core.Location(f.p.getLocation().getX()+1,f.p.getLocation().getY(),0));const op=n.getDefinition().getActions().findIndex(x=>x===name)+1;assert.ok(op>0);await send(f,{type:'npc_option',index:n.getIndex(),clickType:op});}
async function use(f,n,id=obj('tob_hardmode_dust')){f.p.getPacketSender().sendInterfaceRemoval();n.setLocation(new core.Location(f.p.getLocation().getX()+1,f.p.getLocation().getY(),0));await send(f,{type:'item_on_npc',targetIndex:n.getIndex(),itemId:id,slot:f.p.getInventory().getSlotForItemId(id),widgetId:149<<16});}
const unlocked=f=>(f.p.getAttribute('pets:morph-unlocks')??[]).includes('item:'+obj('verzikpet'));

test('native locked Metamorphosis matches RSProx229/2783 and239/4288, even while carrying dust',async t=>{
  const f=actor(t),n=await summon(f);give(f,obj('tob_hardmode_dust'));await action(f,n,'Metamorphosis');
  assert.ok(f.messages.includes(refusal));assert.equal(n.getId(),npc('verzik_pet'));assert.equal(unlocked(f),false);assert.equal(f.p.getInventory().getAmount(obj('tob_hardmode_dust')),1);
});

test('native Sanguine dust Use consumes exactly one and unlocks all six forms permanently',async t=>{
  const f=actor(t),n=await summon(f);give(f,obj('tob_hardmode_dust'),2);await use(f,n);
  assert.equal(unlocked(f),true);assert.equal(f.p.getInventory().getAmount(obj('tob_hardmode_dust')),1);assert.equal(n.getId(),npc('verzik_pet'));
  const seen=new Set();for(let i=0;i<6;i++){seen.add(n.getId());await action(f,n,'Metamorphosis');}
  assert.deepEqual([...seen].sort((a,b)=>a-b),forms.map(([,name])=>npc(name)).sort((a,b)=>a-b));assert.equal(f.p.getAttribute('pets.owned').length,1);
  assert.equal(f.p.getAttribute('clog.items')[obj('verzikpet')],1);for(const [name]of forms.slice(1))assert.equal(f.p.getAttribute('clog.items')[obj(name)],undefined);
});

for(const [itemName,npcName]of forms)test(`native ${itemName} Drop/Pick-up retains the cache item identity`,async t=>{
  const f=actor(t),n=await summon(f,itemName);assert.equal(n.getId(),npc(npcName));await action(f,n,'Pick-up');await action(f,n,'Pick-up');assert.equal(f.p.getInventory().getAmount(obj(itemName)),1);
});

test('repeat dust Use on a new alternate preserves dust and a real Bank transfer preserves its identity',async t=>{
  const f=actor(t),n=await summon(f);give(f,obj('tob_hardmode_dust'),2);await use(f,n);await action(f,n,'Metamorphosis');assert.equal(n.getId(),npc('verzik_pet_maiden'));await use(f,n);assert.equal(f.p.getInventory().getAmount(obj('tob_hardmode_dust')),1);
  await action(f,n,'Pick-up');f.p.getBank(0).open();core.Bank.deposit(f.p,obj('maidenpet'),f.p.getInventory().getSlotForItemId(obj('maidenpet')),1,false);assert.equal(f.p.getBank(0).getAmount(obj('maidenpet')),1);
  core.Bank.withdraw(f.p,obj('maidenpet'),f.p.getBank(0).getSlotForItemId(obj('maidenpet')),1,0);const restored=await drop(f,obj('maidenpet'));assert.equal(restored.getId(),npc('verzik_pet_maiden'));
});

test('wrong dust, foreign follower and zero hitpoints cannot consume Sanguine dust or unlock it',async t=>{
  const f=actor(t),other=actor(t),n=await summon(f);give(f,core.ItemIdentifiers.METAMORPHIC_DUST);await use(f,n,core.ItemIdentifiers.METAMORPHIC_DUST);assert.equal(unlocked(f),false);assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.METAMORPHIC_DUST),1);
  give(other,obj('tob_hardmode_dust'));await use(other,n);assert.equal(unlocked(other),false);assert.equal(other.p.getInventory().getAmount(obj('tob_hardmode_dust')),1);
  give(f,obj('tob_hardmode_dust'));f.p.setHitpoints(0);await use(f,n);assert.equal(unlocked(f),false);assert.equal(f.p.getInventory().getAmount(obj('tob_hardmode_dust')),1);
});

test('queued native dust Use preserves a real Bank-deposited source',async t=>{
  const f=actor(t),n=await summon(f),dust=obj('tob_hardmode_dust');give(f,dust);n.setLocation(new core.Location(3228,3218,0));
  await f.c.dispatch([{type:'item_on_npc',targetIndex:n.getIndex(),itemId:dust,slot:f.p.getInventory().getSlotForItemId(dust),widgetId:149<<16}]);f.c.processTurnPackets();
  f.p.getBank(0).open();core.Bank.deposit(f.p,dust,f.p.getInventory().getSlotForItemId(dust),1,false);f.p.getPacketSender().sendInterfaceRemoval();await drain(f);
  assert.equal(unlocked(f),false);assert.equal(f.p.getBank(0).getAmount(dust),1);
});

test('the selected form and dust unlock survive logout/PlayerSave/fresh native login',async t=>{
  const f=actor(t),n=await summon(f);give(f,obj('tob_hardmode_dust'));await use(f,n);await action(f,n,'Metamorphosis');
  PM.emitPlayerLogout({player:f.p,username:f.p.getUsername()});const g=actor(t);PlayerSave.fromPlayer(f.p).applyToPlayer(g.p);PM.emitPlayerLogin({player:g.p,username:g.p.getUsername(),isNewAccount:false});g.p.needsPlacement=false;
  assert.equal(unlocked(g),true);assert.equal(g.p.getAttribute('pets:current')?.getId(),npc('verzik_pet_maiden'));assert.equal(g.p.getAttribute('pets:active-item'),obj('maidenpet'));assert.equal(g.p.getInventory().getAmount(obj('maidenpet')),0);
});

test('native Probita recovery keeps the chosen Lil Bloat item and one family record',async t=>{
  const f=actor(t),n=await summon(f);give(f,obj('tob_hardmode_dust'));await use(f,n);await action(f,n,'Metamorphosis');await action(f,n,'Metamorphosis');assert.equal(n.getId(),npc('verzik_pet_bloat'));
  PM.emitCustomEvent('pets:release',{player:f.p,npc:n});f.p.setLocation(new core.Location(2611,3295,0));f.p.needsPlacement=false;
  const probita=core.NPC.create(core.NpcIdentifiers.PROBITA,new core.Location(2612,3295,0));core.World.getNpcs().add(probita);t.after(()=>core.World.getNpcs().remove(probita));
  PM.emitCustomEvent('npc-dialogue:action',{player:f.p,npc:probita,npcId:probita.getId(),action:'open_interface',target:'Pet Insurance'});core.TaskManager.process();core.TaskManager.process();
  const index=[...core.CacheDefinitions.getEnumValues(985)].find(([,id])=>id===obj('verzikpet'))[0];
  for(const child of [11,37,37])await send(f,{type:'widget_action',widgetId:(148<<16)|child,groupId:148,childId:child,slot:child===11?6+5*index:0,buttonNum:1});
  assert.equal(f.p.getInventory().getAmount(obj('bloatpet')),1);assert.equal(f.p.getInventory().getAmount(obj('verzikpet')),0);assert.deepEqual(f.p.getAttribute('pets.owned'),[obj('bloatpet')]);
});

for(const [itemName,npcName,form]of [['maidenpet','verzik_pet_maiden',1],['xarpuspet','verzik_pet_xarpus',5]])test(`native menagerie preserves ${itemName} icon, roaming NPC and Take identity`,async t=>{
  const f=actor(t),varbits=[],sender=f.p.getPacketSender(),sendVarbit=sender.sendVarbit.bind(sender);t.mock.method(sender,'sendVarbit',(id,value)=>{varbits.push([id,value]);return sendVarbit(id,value);});
  MaxHouse.maxHouse({player:f.p});House.enterHouse(f.p,false);const h=House.houseFor(f.p),e=h.furnitureEntries().find(x=>x.room.roomKey==='MENAGERIE_INDOORS'&&/HOUSE$/.test(x.furniture.buildableKey));assert.ok(e);
  const id=ConstructionData.BUILDABLE_BY_KEY.get(e.furniture.buildableKey).objectIds[0],at=e.location;f.p.setLocation(at.clone().add(-1,0));f.p.needsPlacement=false;const slot=give(f,obj(itemName));
  await send(f,{type:'item_on_object',objectId:id,x:at.getX(),y:at.getY(),itemId:obj(itemName),slot,widgetId:149<<16});assert.equal(f.p.getInventory().getAmount(obj(itemName)),0);
  assert.ok(h.getNpcs().some(n=>n.getId()===npc(npcName)));assert.ok(varbits.some(([id,value])=>id===core.CacheDefinitions.getVarbitId('poh_menagerie_multiform_verzikpet')&&value===form));
  await send(f,{type:'object_option',id,x:at.getX(),y:at.getY(),action:'View'});assert.equal(f.p.getInterfaceId(),211);
  const row=[...core.CacheDefinitions.getEnumValues(985)].find(([,itemId])=>itemId===obj('verzikpet'))[0];for(let i=0;i<2;i++)await send(f,{type:'widget_action',widgetId:(211<<16)|7,groupId:211,childId:7,slot:row,buttonNum:1});
  assert.equal(f.p.getInventory().getAmount(obj(itemName)),1);assert.equal(f.p.getInventory().getAmount(obj('verzikpet')),0);
});

test('a real trade opened while walking cancels the Sanguine dust Use',async t=>{
  const f=actor(t),other=actor(t),n=await summon(f),dust=obj('tob_hardmode_dust');give(f,dust);n.setLocation(new core.Location(3228,3218,0));
  await f.c.dispatch([{type:'item_on_npc',targetIndex:n.getIndex(),itemId:dust,slot:f.p.getInventory().getSlotForItemId(dust),widgetId:149<<16}]);f.c.processTurnPackets();
  f.p.getTrading().requestTrade(other.p);other.p.getTrading().requestTrade(f.p);assert.equal(f.p.getStatus(),core.PlayerStatus.TRADING);await drain(f);
  assert.equal(unlocked(f),false);assert.equal(f.p.getInventory().getAmount(dust),1);f.p.getTrading().closeTrade();
});
