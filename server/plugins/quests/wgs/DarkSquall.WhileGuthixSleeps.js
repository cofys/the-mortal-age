/** Black Knight Catacombs: Wiki route, cache scenery, Silif's rescue and escort. */
module.exports=function registerDarkSquall({api,stage,advance,held,give,val,play,ATTRIBUTES}){
 const {Area,Boundary,Location,Item,ItemOnGroundManager,Skill,MagicSpellbook,CombatType}=api.core;
 const TILE=53349,TRAPDOOR=53350,TILE_PARENT=54076;
 const BRIDGE_NORTH=53511,BRIDGE_SOUTH=53512,WALL_BOTTOM=53513,WALL_TOP=53514;
 const BASE_DOOR=53365,BASE_EXIT=53366,SHORTCUT_INNER=53478,SHORTCUT_OUTER=53479,CELL=53443;
 const ELITE_WARDROBE=53361,ELITE_WARDROBE_OPEN=53362,SQUALL_WARDROBE=53372,SQUALL_WARDROBE_OPEN=53374,DESK=53359,KEY_RACK=53363,SUPPLY_TABLE=53367,RUNE_TABLE=53503;
 const JAIL_SILIF=13524,ARMOURED_SILIF=13521,AKRISAE=13543;
 const ELITE=[29560,29562,29564],SQUALL=[29566,29568,29570],CELL_KEY=29534,STRANGE_ORB=29535,TELEORB=29536;
 const FOOD=379,RESTORE=2430,KNIGHTS=[13463,13464],KINSHRA=[13463,13464,13465,13466,13467,13468,13469,13470];
 const DISGUISE_HELM=1139,DISGUISE_BODY=1101,UNPOWERED_ORB=567,COSMIC=564;
 const ICE_TELEPORT_ATTRIBUTE='while-guthix-sleeps:ice-mountain-teleport';
 const ORB_ATTRIBUTE='while-guthix-sleeps:catacomb-open',ARMOUR_ATTRIBUTE='while-guthix-sleeps:elite-armour-drops';
 const FOOD_ATTRIBUTE='while-guthix-sleeps:silif-fed',POTION_ATTRIBUTE='while-guthix-sleeps:silif-restored';
 const ARMOUR_GIVEN_ATTRIBUTE='while-guthix-sleeps:silif-armour',SHORTCUT_ATTRIBUTE='while-guthix-sleeps:catacomb-shortcut';
 ATTRIBUTES.push(ICE_TELEPORT_ATTRIBUTE,ORB_ATTRIBUTE,ARMOUR_ATTRIBUTE,FOOD_ATTRIBUTE,POTION_ATTRIBUTE,ARMOUR_GIVEN_ATTRIBUTE,SHORTCUT_ATTRIBUTE);
 const guards=new WeakMap(),followers=new WeakMap(),captives=new WeakMap();
 const dressed=(p,ids)=>ids.every(id=>p.getEquipment().contains(id));
 const disguise=p=>dressed(p,ELITE)||dressed(p,SQUALL);
 const active=p=>stage(p)>=400;
 const id=e=>e.definition?.id??api.core.ObjectDefinition.forPlayer(e.objectId,e.player)?.id??e.objectId;
 const ready=p=>val(p,FOOD_ATTRIBUTE)&&val(p,POTION_ATTRIBUTE);
 const hasArmour=p=>ELITE.every(item=>held(p,item));
 function login({player}){sync(player);mapChange({player});}
 function mapChange({player:p}){
  const l=p.getLocation(),s=stage(p);
  if(s>=490&&s<560&&l.getZ()===2&&l.getX()>=4096&&l.getX()<=4163&&l.getY()>=4660&&l.getY()<=4863){
   if(!captives.has(p))captives.set(p,api.spawnNpc({id:JAIL_SILIF,x:4135,y:4790,z:2,wanderRadius:0,owner:p,ownerOnly:true}));
   if(val(p,ARMOUR_GIVEN_ATTRIBUTE))captives.get(p).setNpcTransformationId(ARMOURED_SILIF);
  }else if(captives.has(p)){api.removeNpc(captives.get(p));captives.delete(p);}
  if(s<560||s>=610||followers.has(p)||l.getX()<4096||l.getX()>4163||l.getY()<4660||l.getY()>4863||![1,2].includes(l.getZ()))return;
  const position=s>=580&&l.getZ()===1?new Location(4120,4840,1):l.transform(-1,0);
  followers.set(p,api.spawnNpc({id:ARMOURED_SILIF,x:position.getX(),y:position.getY(),z:position.getZ(),wanderRadius:0,owner:p,ownerOnly:true}));
 }

 function group({player,npcId}){
  if(stage(player)<400||stage(player)>=490||![13540,13511,AKRISAE].includes(npcId))return false;
  const who=npcId===13540?'idria':npcId===13511?'thaerisk':'akrisae';
  play(player,npcId,'forming-a-fellowship-second-recruitment-talking-to-the-akrisae-after-all-the-heroes-are-assembled-talking-to-'+who+'-again');return true;
 }
 function iceTeleport({player:p,npcId,stepId}){
  if(npcId!==AKRISAE||stepId!=='wgs-ice-mountain'||stage(p)<400||stage(p)>=490)return;
  const l=p.getLocation();if(l.getZ()!==0||l.getX()<2948||l.getX()>3001||l.getY()<3327||l.getY()>3356)return;
  if(val(p,ICE_TELEPORT_ATTRIBUTE)){p.sendMessage('You have already used Akrisae’s teleport to Ice Mountain.');return;}
  p.setAttribute(ICE_TELEPORT_ATTRIBUTE,1);p.getCombat().reset();p.moveTo(new Location(3006,3499,0));
 }
 function sync(p){if(!active(p))return;p.getPacketSender().sendVarbit(10803,val(p,ORB_ATTRIBUTE)?2:0).sendVarbit(10780,val(p,ARMOUR_GIVEN_ATTRIBUTE)?3:2);}
 function cleanup({player}){const c=captives.get(player);if(c)api.removeNpc(c);captives.delete(player);const n=followers.get(player);if(n)api.removeNpc(n);followers.delete(player);}
 function follow(p){cleanup({player:p});const l=p.getLocation();followers.set(p,api.spawnNpc({id:ARMOURED_SILIF,x:l.getX(),y:l.getY(),z:l.getZ(),wanderRadius:0,owner:p,ownerOnly:true}));advance(p,560);}
 class CatacombsArea extends Area{
  constructor(){super([new Boundary(4096,4163,4660,4863,1),new Boundary(4096,4163,4660,4863,2)]);}
  npcAggression(p,n){return KINSHRA.includes(n.getId())?!disguise(p):null;}
  process(m){
   if(m.isNpc?.())return;
   if(!m.isPlayer?.())return;const p=m.getAsPlayer(),f=followers.get(p);if(!f)return;
   const l=p.getLocation(),n=f.getLocation();
   if(stage(p)>=580)return;
   if(l.getZ()!==n.getZ()||l.getDistance(n)>12)f.moveTo(l.transform(-1,0));
   else if(l.getDistance(n)>1)api.core.PathFinder.calculateWalkRoute(f,l.getX(),l.getY());
   if(stage(p)===560&&l.getZ()===1&&Math.abs(l.getX()-4120)<=3&&Math.abs(l.getY()-4840)<=3){
    f.getMovementQueue().reset();advance(p,580);play(p,ARMOURED_SILIF,'the-dark-squall-leaving-silif-by-the-map-board');
   }
  }
  postLeave(m,logout){if(m.isPlayer?.())cleanup({player:m.getAsPlayer()});}
 }
 function fortress({player,objectId,object}){
  if(!active(player)||objectId!==api.core.ObjectIdentifiers.STURDY_DOOR)return false;
  if(!disguise(player)&&!dressed(player,[DISGUISE_HELM,DISGUISE_BODY])){player.sendMessage('You need a guard disguise to enter the fortress.');return true;}
  const l=object.getLocation();player.moveTo(new Location(l.getX(),player.getLocation().getY()<=l.getY()?l.getY()+1:l.getY()-1,l.getZ()));return true;
 }
 function inspect(e){if(!active(e.player)||id(e)!==TILE)return false;e.player.sendMessage('The green carved tile bears the symbol of an orb.');return true;}
 function charge(e){
  if(!active(e.player)||e.objectId!==TILE_PARENT)return;
  const p=e.player,name=api.core.CacheDefinitions.getSpellName(e.spellWidget,e.spellItemId),match=/^charge (water|earth|fire|air) orb$/i.exec(name||'');
  if(!match)return;e.handled=true;
  if(val(p,ORB_ATTRIBUTE)){p.sendMessage('The trapdoor is already revealed.');return;}
  const index=['water','earth','fire','air'].indexOf(match[1].toLowerCase()),rune=[555,557,554,556][index],level=[56,60,63,66][index];
  if(p.getSpellbook()!==MagicSpellbook.NORMAL||p.getSkillManager().getCurrentLevel(Skill.MAGIC)<level){p.sendMessage('You need the standard spellbook and the Magic level for this spell.');return;}
  const cost=[[UNPOWERED_ORB,1],[COSMIC,3],[rune,30]];
  if(cost.some(([item,n])=>p.getInventory().getAmount(item)<n)){p.sendMessage('You need an unpowered orb, three cosmic runes and thirty elemental runes.');return;}
  for(const[item,n]of cost)p.getInventory().deleteNumber(item,n);
  p.getSkillManager().addExperience(Skill.MAGIC,[66,70,73,76][index]);p.setAttribute(ORB_ATTRIBUTE,1);sync(p);
  play(p,AKRISAE,'the-dark-squall-opening-the-trapdoor-to-the-black-knight-catacombs');
 }
 function enter(e){if(!active(e.player)||id(e)!==TRAPDOOR||!val(e.player,ORB_ATTRIBUTE))return false;advance(e.player,490);e.player.moveTo(new Location(4105,4675,1));return true;}
 function bridge(e){const n=id(e);if(!active(e.player)||![BRIDGE_NORTH,BRIDGE_SOUTH].includes(n))return false;e.player.moveTo(new Location(4112,n===BRIDGE_SOUTH?4703:4696,1));return true;}
 function wall(e){const n=id(e);if(!active(e.player)||![WALL_BOTTOM,WALL_TOP].includes(n))return false;e.player.moveTo(new Location(4133,n===WALL_BOTTOM?4727:4724,n===WALL_BOTTOM?2:1));return true;}
 function door(e){
  const n=id(e),p=e.player;if(!active(p)||![BASE_DOOR,BASE_EXIT,SHORTCUT_INNER,SHORTCUT_OUTER].includes(n))return false;
  if(n===BASE_DOOR&&!disguise(p)){p.sendMessage('You need elite black armour or Dark Squall robes to enter the inner base.');return true;}
  if(n===SHORTCUT_OUTER&&!val(p,SHORTCUT_ATTRIBUTE)){p.sendMessage('The solid door is locked from the other side.');return true;}
  if(n===SHORTCUT_INNER)p.setAttribute(SHORTCUT_ATTRIBUTE,1);
  const destination=n===BASE_DOOR?[4113,4842,1]:n===BASE_EXIT?[4104,4798,2]:n===SHORTCUT_INNER?[4117,4690,1]:[4097,4791,2];
  p.moveTo(new Location(...destination));return true;
 }
 function search(e){
  const n=id(e),p=e.player;if(!active(p)||stage(p)<490)return false;
  const items=n===ELITE_WARDROBE_OPEN?ELITE:n===SQUALL_WARDROBE_OPEN?SQUALL:n===DESK?[STRANGE_ORB]:n===KEY_RACK?[CELL_KEY]:n===SUPPLY_TABLE?[FOOD,RESTORE]:n===RUNE_TABLE?[563,560]:null;
  if(!items)return false;
  if(!disguise(p)){p.sendMessage('You need a disguise before searching the Dark Squall’s supplies.');return true;}
  const missing=items.filter(item=>!held(p,item));if(p.getInventory().getFreeSlots()<missing.length){p.sendMessage(`You need ${missing.length} free inventory spaces.`);return true;}
  for(const item of missing)give(p,item);return true;
 }
 function wardrobe(e){
  const n=id(e),p=e.player;if(!active(p)||stage(p)<490||![ELITE_WARDROBE,ELITE_WARDROBE_OPEN,SQUALL_WARDROBE,SQUALL_WARDROBE_OPEN].includes(n))return false;
  const next=n===ELITE_WARDROBE?ELITE_WARDROBE_OPEN:n===SQUALL_WARDROBE?SQUALL_WARDROBE_OPEN:n===ELITE_WARDROBE_OPEN?ELITE_WARDROBE:SQUALL_WARDROBE;
  api.core.ObjectManager.deregister(e.object,true);
  api.core.ObjectManager.register(new api.core.GameObject(next,e.object.getLocation().clone(),e.object.getType(),e.object.getFace(),null),true);
  return true;
 }
 function openCell(e){
  if(!active(e.player)||id(e)!==CELL)return false;const p=e.player;
  if(!held(p,CELL_KEY)&&stage(p)<520){p.sendMessage('The cell is locked. Find its key in the inner base.');return true;}
  api.core.ObjectManager.deregister(e.object,true);
  api.core.ObjectManager.register(new api.core.GameObject(CELL+1,new Location(4131,4791,2),0,1,null),true);
  advance(p,520);return true;
 }
 function silif({player,npcId,npc}){
  if(!active(player)||![JAIL_SILIF,ARMOURED_SILIF].includes(npcId))return false;
  let v=stage(player)>=580&&!held(player,TELEORB)?'leaving-silif-by-the-map-board':stage(player)>=580?'talking-to-silif-by-the-map-board':stage(player)<520?'talking-to-silif':followers.has(player)?'talking-to-silif-while-following-the-player':!ready(player)?'talking-to-silif-after-unlocking-his-cell':val(player,ARMOUR_GIVEN_ATTRIBUTE)?'talking-to-silif-after-he-returns-to-his-cell':'talking-to-silif-after-he-has-been-restored-and-fed';
  play(player,npcId,'the-dark-squall-'+v);return true;
 }
 function feed(p,itemId){
  const item=p.getInventory().getItems().find(i=>i?.getId()===itemId),name=item?.getDefinition().getName()||'';
  const potion=/^Restore potion\([1-4]\)$/.test(name),food=api.core.CacheDefinitions.getItem(itemId)?.inventoryActions?.includes('Eat');
  if(!potion&&!food)return false;
  const attribute=potion?POTION_ATTRIBUTE:FOOD_ATTRIBUTE;
  if(val(p,attribute)){p.sendMessage(`Silif has already ${potion?'had the restore potion':'eaten'}.`);return true;}
  p.getInventory().deleteNumber(itemId,1);p.setAttribute(attribute,1);advance(p,ready(p)?540:530);
  p.sendMessage(`You carefully ${potion?'administer the restoration potion':'feed the food'} to Silif.`);return true;
 }
 function use(e){
  const {player:p,target:npc,itemId}=e;if(!active(p)||npc.getId()!==JAIL_SILIF||stage(p)<520)return;
  if(ELITE.includes(itemId)&&ready(p)&&hasArmour(p)){e.handled=true;for(const item of ELITE)p.getInventory().deleteNumber(item,1);p.setAttribute(ARMOUR_GIVEN_ATTRIBUTE,1);advance(p,550);sync(p);mapChange({player:p});play(p,JAIL_SILIF,'the-dark-squall-talking-to-silif-after-he-returns-to-his-cell');return;}
  e.handled=feed(p,itemId);
 }
 function line(e){if(active(e.player)&&e.text==='Very well. I\'m right behind you.'&&[JAIL_SILIF,ARMOURED_SILIF].includes(e.npcId))e.after=()=>follow(e.player);}
 function action({player:p,stepId}){
  if(!active(p))return;
  if(stepId==='V0u4qK'&&!val(p,FOOD_ATTRIBUTE)){const item=p.getInventory().getItems().find(i=>i?.getId()>=0&&api.core.CacheDefinitions.getItem(i.getId())?.inventoryActions?.includes('Eat'));if(item)feed(p,item.getId());}
  if(stepId==='Fe1qbj'&&!val(p,POTION_ATTRIBUTE)){const item=p.getInventory().getItems().find(i=>/^Restore potion\([1-4]\)$/.test(i?.getDefinition().getName()||''));if(item)feed(p,item.getId());}
  if(stepId==='HNclnD'&&hasArmour(p)){for(const item of ELITE)p.getInventory().deleteNumber(item,1);p.setAttribute(ARMOUR_GIVEN_ATTRIBUTE,1);advance(p,550);sync(p);mapChange({player:p});}
  if(stepId==='IjPhKv')give(p,TELEORB);
 }
 function condition({player:p,stepId,pages}){
  if(!active(p)||!pages?.some(v=>v.page.replace(/^Transcript:/,'')==='While Guthix Sleeps'))return;
  const food=p.getInventory().getItems().some(i=>i?.getId()>=0&&api.core.CacheDefinitions.getItem(i.getId())?.inventoryActions?.includes('Eat'));
  const potion=p.getInventory().getItems().some(i=>/^Restore potion\([1-4]\)$/.test(i?.getDefinition().getName()||''));
  const known={ss67yt:true,KQ_0Zs:false,'0X_0pv':food&&potion,LSTOP_:food&&potion,SkwosK:food&&!potion,hpM0B3:food&&!potion,ncjEmk:!food&&potion,SoF5aB:!food&&potion,NMH_xz:!disguise(p),Q1IpPk:disguise(p),tPjqCB:hasArmour(p),iIh1ce:!hasArmour(p),VlMei7:!hasArmour(p),hPixVX:hasArmour(p)};
  if(stepId in known)return known[stepId];
 }
 function killed({npc,killer}){
  if(KINSHRA.includes(npc.getId()))guards.delete(npc);
  const p=killer?.isPlayer?.()?killer.getAsPlayer():null;if(!p||!KNIGHTS.includes(npc.getId())||!active(p)||stage(p)<490||stage(p)>=900)return;
  let bit=ELITE.findIndex((_,i)=>!(val(p,ARMOUR_ATTRIBUTE)&(1<<i)));if(bit<0)bit=Math.floor(Math.random()*3);
  p.setAttribute(ARMOUR_ATTRIBUTE,val(p,ARMOUR_ATTRIBUTE)|(1<<bit));ItemOnGroundManager.registerLocation(p,new Item(ELITE[bit],1),npc.getLocation().clone());
 }
 function modifyHit({npc,hit}){
  if(!KINSHRA.includes(npc.getId())||!(npc.getArea() instanceof CatacombsArea)||!hit.getAttacker().isPlayer())return;
  const type=hit.getCombatType();let prayer=guards.get(npc);
  if(!prayer){prayer={style:type,remaining:99};guards.set(npc,prayer);}
  const blocked=prayer.remaining>0&&prayer.style===type;
  if(blocked){hit.setTotalDamage(0);hit.getAttacker().sendMessage('The elite guard’s protection prayer blocks your attack. Switch combat styles.');}
  else {
   prayer.remaining=Math.max(0,prayer.remaining-hit.getCombatMethod().attackSpeed(hit.getAttacker()));
   if(KNIGHTS.includes(npc.getId())&&type!==CombatType.MAGIC){for(const splat of hit.getHits())splat.setDamage(Math.max(0,splat.getDamage()-7));hit.updateTotalDamage();}
  }
  prayer.style=type;
  npc.setHeadIcon(prayer.remaining>0?type===CombatType.MELEE?0:type===CombatType.RANGED?1:2:-1);
 }
 api.registerArea(new CatacombsArea());
 api.onObjectInteraction('Sturdy door',{Open:fortress});
 api.onObjectInteraction('Tile',{Inspect:inspect});
 api.onSpellOnObject(charge);
 api.onObjectInteraction('Trapdoor',{'Climb-down':enter});
 api.onObjectInteraction('Bridge',{'Jump-to':bridge});
 api.onObjectInteraction('Wall',{'Climb-up':wall,'Jump-down':wall});
 api.onObjectInteraction('Solid door',{Open:door});
 api.onObjectInteraction('Wardrobe',{Open:wardrobe,Close:wardrobe,Search:search});
 for(const name of ['Desk','Key rack','Table'])api.onObjectInteraction(name,{Search:search});
 api.onObjectInteraction('Gate',{Open:openCell});
 api.onNpcInteraction('Silif',{'Talk-to':silif});
 for(const name of ['Idria','Thaerisk','Akrisae'])api.onNpcInteraction(name,{'Talk-to':group});
 api.onItemOnNpc(use,{noted:false});
 api.onNpcDeath(killed);
 api.onNpcHitModify(modifyHit);
 api.onNpcDialogueCondition(condition);
 api.onCustomEvent('npc-dialogue:line',line);
 api.onCustomEvent('npc-dialogue:choice',iceTeleport);
 api.onCustomEvent('npc-dialogue:action',action);
 api.onPlayerLogin(login);
 api.onPlayerMapSquareChange(mapChange);
 api.onPlayerLogout(cleanup);
};
