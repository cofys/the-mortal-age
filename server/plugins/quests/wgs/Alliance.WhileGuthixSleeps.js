/** Surok's capture, the one-use exchange teleport, and Lucien's ambush. */
module.exports=function registerAlliance({api,quest,stage,advance,held,give,play}){
 const {Area,PrivateArea,Boundary,Location,Item,Spell,MagicSpellbook,Bank}=api.core;
 const GROUP=[13540,13543,13511],SILIF=13519,SUROK=13548,STRANGE_ORB=29535,ROBES=[29566,29568,29570];
 const CELL=53281,ICE_WALL=53607,LEDGE=53288,LADDER=53370,LADDER_TOP=53371;
 const scenes=new WeakMap(),dressed=p=>ROBES.every(id=>p.getEquipment().contains(id));
 const atCastle=p=>p.getLocation().getZ()===0&&p.getLocation().getX()>2948&&p.getLocation().getX()<3001&&p.getLocation().getY()>3327&&p.getLocation().getY()<3356;
 function group({player:p,npcId}){
  if(!GROUP.includes(npcId)||!atCastle(p))return false;const s=stage(p);let v;
  if(s===610)v='the-dark-squall-after-to-the-group-after-planting-the-teleorb-on-surok';
  else if(s===620)v='the-dark-squall-talking-to-'+(npcId===13540?'idria':npcId===13511?'thaerisk':'akrisae')+'-again';
  else if(s>=650&&s<700)v='into-the-chasm-talking-to-the-group';
  else if(s>=880&&s<900)v='into-the-chasm-talking-to-the-group-2';
  else if(s>=900)v='post-quest-dialogue-talking-to-'+(npcId===13540?'idria':npcId===13511?'thaerisk':'akrisae');
  else return false;play(p,npcId,v);return true;
 }
 function postQuestTalk({player:p,npcId}){
  if(stage(p)<610||!atCastle(p))return false;
  if(npcId===SILIF)play(p,npcId,stage(p)>=900?'post-quest-dialogue-talking-to-silif':'the-dark-squall-talking-to-silif-after-rescuing-him');
  else if(npcId===SUROK&&stage(p)>=900)play(p,npcId,'post-quest-dialogue-talking-to-surok');else return false;return true;
 }
 function reclaimRobes(p){
  const missing=ROBES.filter(id=>!held(p,id)&&!p.getEquipment().contains(id)&&!Array.from({length:Bank.TOTAL_BANK_TABS},(_,tab)=>p.getBank(tab)).some(bank=>bank.contains(id)));
  if(p.getInventory().getFreeSlots()<missing.length){p.sendMessage('You need '+missing.length+' free inventory spaces for the robes.');return;}
  for(const id of missing)give(p,id);
 }
 function line(e){
  const s=stage(e.player);
  if(s===610&&e.text==="Let's finish this.")e.after=()=>advance(e.player,620);
  if(s>=650&&s<700&&e.text==='Good luck, [player name].')e.after=()=>advance(e.player,700);
  if(s>=880&&s<900&&e.text==='And the world will be safe once more.')e.after=()=>{const ds2={player:e.player,key:'dragon_slayer_ii',complete:false};api.emitCustomEvent('quest:is-complete',ds2);if(!ds2.complete)quest.complete(e.player);};
  if(s>=880&&s<900&&e.text==='Yes! The dragonkin will rise once more!')e.after=()=>quest.complete(e.player);
 }
 function swap(p){if(stage(p)!==620)return;if(!dressed(p)){p.sendMessage('Put on the Dark Squall robes before exchanging places with Surok.');return;}advance(p,630);p.getCombat().reset();p.moveTo(new Location(4136,4849,2));p.sendMessage('Akrisae swaps your location with Surok’s.');}
 function cell({player:p,objectId,definition}){if((definition?.id??objectId)!==CELL||stage(p)!==620)return false;play(p,13543,'the-dark-squall-talking-to-akrisae-again');return true;}
 function action({player:p,stepId,npcId}){if(stepId==='h_h2X8'&&npcId===SILIF&&stage(p)>=900&&atCastle(p))reclaimRobes(p);if(stepId==='Wfq-j9')swap(p);if(stepId==='MvBtiO'&&scenes.has(p)){const f=scenes.get(p);for(const n of f.cast)if([13618,13622,13559,13613,13616,13564].includes(n.getId()))api.removeNpc(n);}
  if(stepId==='MWB2tX'&&scenes.has(p)){advance(p,650);p.getMovementQueue().setBlockMovement(false);p.moveTo(new Location(2945,3820,0));}}
 function ladder({player:p,objectId,definition}){const n=definition?.id??objectId;if(stage(p)<630||stage(p)>=700||![LADDER,LADDER_TOP].includes(n))return false;p.moveTo(new Location(4142,4854,n===LADDER?2:1));return true;}
 class TeleorbRunes extends Spell{
  spellId(){return -1;}levelRequired(){return 0;}itemsRequired(){return [new Item(563,1),new Item(560,1)];}equipmentRequired(){return [];}startCast(){}baseExperience(){return 0;}
  getSpellbook(){return this.book;}
  cast(p){this.book=p.getSpellbook();return this.canCast(p,true);}
 }
 const runes=new TeleorbRunes();
 function orb(e){
  const p=e.player;if(e.itemId!==STRANGE_ORB||String(e.option).toLowerCase()!=='activate'||stage(p)<630)return;e.handled=true;
  const l=p.getLocation();if(l.getZ()!==2||l.getX()<4135||l.getX()>4138||l.getY()<4848||l.getY()>4851){p.sendMessage('The strange teleorb must be activated in the centre of Surok’s room.');return;}
  if(!dressed(p)){p.sendMessage('Keep your Dark Squall disguise on before seeking Lucien.');return;}
  if(!runes.cast(p))return;p.getCombat().reset();p.moveTo(new Location(2941,3820,0));p.sendMessage('The strange teleorb transports you to Lucien’s camp.');
 }
 class LucienScene extends PrivateArea{
  constructor(p){super([new Boundary(2938,2970,3800,3835,0),new Boundary(2938,2970,3800,3835,1)]);this.player=p;this.cast=[];}
  canAttack(){return false;}
  postLeave(m,logout){if(m===this.player){for(const n of this.cast)api.removeNpc(n);scenes.delete(m);m.getMovementQueue().setBlockMovement(false);if(logout)m.moveTo(new Location(2945,3820,0));}super.postLeave(m,logout);}
 }
 function wall({player:p,objectId,definition}){if((definition?.id??objectId)!==ICE_WALL||stage(p)<630||stage(p)>=700)return false;if(!dressed(p)){p.sendMessage('Wear your Dark Squall disguise before approaching Lucien.');return true;}p.moveTo(new Location(2942,3822,1));return true;}
 function ledge({player:p,objectId,definition}){
  if((definition?.id??objectId)!==LEDGE||stage(p)<630||stage(p)>=700)return false;
  const f=new LucienScene(p);scenes.set(p,f);f.enter(p);p.moveTo(new Location(2945,3822,1));p.getMovementQueue().setBlockMovement(true);
  for(const[id,x,y,z]of [[13525,2954,3815,0],[13618,2949,3819,0],[13620,2950,3818,0],[13622,2951,3819,0],[13559,2952,3818,0],[13613,2953,3819,0],[13615,2955,3819,0],[13616,2956,3818,0],[13564,2948,3818,0]]){const n=api.spawnNpc({id,x,y,z,wanderRadius:0,owner:p,ownerOnly:true});f.enter(n);f.cast.push(n);}
  play(p,13525,'the-dark-squall-lucien-s-wrath');return true;
 }
 function condition({player:p,stepId,pages}){
  if(!pages?.some(v=>v.page.replace(/^Transcript:/,'')==='While Guthix Sleeps'))return;
  const ds2={player:p,key:'dragon_slayer_ii',complete:false};if(['QKDh3l','TAXtQB'].includes(stepId))api.emitCustomEvent('quest:is-complete',ds2);
  const values={'5Wt8Mm':held(p,STRANGE_ORB),hhVM2j:!held(p,STRANGE_ORB),'_4EMtV':dressed(p),XJb36e:!dressed(p),QKDh3l:!ds2.complete,TAXtQB:ds2.complete};if(stepId in values)return values[stepId];
 }
 api.onNpcInteraction('Silif',{'Talk-to':postQuestTalk});api.onNpcInteraction('Surok Magis',{'Talk-to':postQuestTalk});
 api.onNpcInteraction('Akrisae',{'Talk-to':group});api.onNpcInteraction('Idria',{'Talk-to':group});api.onNpcInteraction('Thaerisk',{'Talk-to':group});
 function claimLadder(e){if(ladder(e))e.handled=true;}
 api.onCustomEvent('ladders:climb',claimLadder);
 api.onObjectInteraction('Cell gate',{Open:cell});api.onObjectInteraction('Ladder',{'Climb-up':ladder,'Climb-down':ladder});
 api.onObjectInteraction('Ice wall',{Climb:wall,'Climb-up':wall});api.onObjectInteraction('Ledge',{'Jump-across':ledge,Jump:ledge});
 api.onItemAction(orb);api.onNpcDialogueCondition(condition);api.onCustomEvent('npc-dialogue:line',line);api.onCustomEvent('npc-dialogue:action',action);
 return {swap,orb,condition,line,group,postQuestTalk,action};
};
