/** Wiki's Balance Elemental and quest demon encounters, with a checkpoint between them. */
module.exports=function registerStone({api,stage,advance,play,replace,hit}){
 const {PrivateArea,Boundary,Location,Skill,Animation,Graphic,HitDamage,HitMask,CombatType,PrayerHandler,RegionManager,World}=api.core;
 const BALANCE=13528,INTRO=13530,MOVARIO=13569,DARVE=13571,LUCIEN=13526,IDRIA=13582,GUARDIAN=13577,DEMONS=[13601,13602];
 const STONE=53823,PLINTH=53826,STYLES=[CombatType.MELEE,CombatType.RANGED,CombatType.MAGIC];
 const PRAYERS=[PrayerHandler.PROTECT_FROM_MELEE,PrayerHandler.PROTECT_FROM_MISSILES,PrayerHandler.PROTECT_FROM_MAGIC];
 const ATTACKS=[11348,11354,11342],SPECIALS=[11349,11355,11343],TRANSITIONS=[[0,11351,11345],[11344,0,11338],[11339,11350,0]];
 const COMBAT_SKILLS=[Skill.ATTACK,Skill.STRENGTH,Skill.DEFENCE,Skill.RANGED,Skill.MAGIC,Skill.HITPOINTS,Skill.PRAYER];
 const sessions=new WeakMap(),demonStates=new WeakMap(),loc=(x,y)=>new Location(x,y,0),random=(a,b)=>a+Math.floor(Math.random()*(b-a+1));
 const {weaponName}=require('../../combat/effects/GearChecks.EquipmentEffects');
 const DEMONBANE=['silverlight','silverlight (dyed)','darklight','arclight','emberlight','scorching bow','purging staff'];
 const BANE_SPELLS=[api.core.CombatSpells.INFERIOR_DEMONBANE,api.core.CombatSpells.SUPERIOR_DEMONBANE,api.core.CombatSpells.DARK_DEMONBANE];
 const alive=n=>n&&n.getHitpoints()>0&&World.getNpcs().get(n.getIndex())===n;
 function spawn(a,id,x,y,hp){const n=api.spawnNpc({id,x,y,z:0,wanderRadius:0,owner:a.player,ownerOnly:true});if(hp)n.setMaxHitpoints(hp).setHitpoints(hp);n.setScriptedMovement(true);a.enter(n);a.cast.add(n);return n;}
 function remove(a,n){if(n){a.cast.delete(n);api.removeNpc(n);}}
 function sight(a,n){return RegionManager.canProjectileAttackBounds(n.getLocation(),a.player.getLocation(),3,3,1,1,a);}
 function protect(a,style){
  if(a.boss.getHitpoints()>=550){a.protection=[];a.boss.setHeadIcon(-1);return;}
  a.protection=a.boss.getHitpoints()<200?[style,(style+1)%3]:[style];
  const icons=[[0,8,7],[8,1,6],[7,6,2]];a.boss.setHeadIcon(a.protection.length===2?icons[a.protection[0]][a.protection[1]]:style);
 }
 class StoneArea extends PrivateArea{
  constructor(p){super([new Boundary(4096,4159,4352,4419,0)]);this.player=p;this.cast=new Set();this.ticks=0;this.style=1;this.attacks=0;this.nextAttack=6;this.pending=[];this.protection=[];this.prayerDamage=0;this.lastStyle=0;this.lastHp=750;this.started=false;}
  isMulti(){return stage(this.player)>=850;}
  canAttack(a,b){return a===this.player&&(b===this.boss||this.demons?.includes(b))?null:false;}
  process(m){
   if(m!==this.player)return;this.ticks++;for(const n of this.cast)n.getCombat().getLastAttack().reset();
   if(stage(m)>=850&&stage(m)<880){processDemons(this);return;}
   if(!this.started||!alive(this.boss)||m.getHitpoints()<=0)return;
   const hp=this.boss.getHitpoints();this.prayerDamage+=Math.max(0,this.lastHp-hp);this.lastHp=hp;
   if(hp<550&&!this.protection.length||hp<200&&this.protection.length===1||this.prayerDamage>=80){this.prayerDamage=0;protect(this,this.lastStyle);}
   for(const attack of this.pending.filter(a=>a.tick<=this.ticks)){
    if(!m.getPrayerActive()[PRAYERS[attack.style]]){
     hit(m,random(0,attack.special?89:40));
     if(attack.special){const skills=m.getSkillManager();for(const s of COMBAT_SKILLS.filter(s=>s!==Skill.HITPOINTS))skills.setCurrentLevel(s,Math.max(1,Math.floor(skills.getCurrentLevel(s)/2)),true);m.sendMessage('The Balance Elemental drains your stats and Prayer!');}
    }
    if(attack.changeAfter){const old=this.style,choices=[0,1,2].filter(s=>s!==old&&!m.getPrayerActive()[PRAYERS[s]]);this.style=choices[random(0,choices.length-1)];this.boss.performAnimation(new Animation(TRANSITIONS[old][this.style]));this.boss.forceChat(['Air!','Fire!','Water!'][this.style]);}
   }
   this.pending=this.pending.filter(a=>a.tick>this.ticks);
   if(this.ticks<this.nextAttack||!sight(this,this.boss))return;
   const special=this.attacks%4===0||this.attacks%4===3;
   this.boss.performAnimation(new Animation((special?SPECIALS:ATTACKS)[this.style]));
   this.pending.push({tick:this.ticks+(hp>375?2:1),style:this.style,special,changeAfter:this.attacks%4===3});
   this.attacks++;this.nextAttack=this.ticks+(hp<200?2:hp<550?5:6);
  }
  postLeave(m,logout){if(m===this.player){for(const n of this.cast)api.removeNpc(n);sessions.delete(m);m.getMovementQueue().setBlockMovement(false);if(stage(m)>=850)for(const s of COMBAT_SKILLS)m.getSkillManager().setCurrentLevel(s,Math.min(m.getSkillManager().getCurrentLevel(s),m.getSkillManager().getMaxLevel(s)),true);if(logout)m.moveTo(new Location(3229,9527,2));}super.postLeave(m,logout);}
 }
 function enter({player:p}){
  if(stage(p)<800||stage(p)>=900||sessions.has(p))return;const a=new StoneArea(p);sessions.set(p,a);a.enter(p);p.moveTo(loc(4134,4380));replace(p,STONE,[4139,4383,0]);
  if(stage(p)>=850){startDemons(a);return;}
  if(stage(p)>=820){afterBalance(a);return;}
  a.boss=spawn(a,INTRO,4135,4383,750);play(p,INTRO,'into-the-chasm-the-balance-elemental');
 }
 function afterBalance(a){a.started=false;a.pending=[];a.boss=null;spawn(a,MOVARIO,4134,4386);spawn(a,DARVE,4133,4386);}
 function startBalance(a){if(a.started)return;remove(a,a.boss);a.boss=spawn(a,BALANCE,4135,4383,750);a.boss.getMovementQueue().setBlockMovement(true);a.started=true;advance(a.player,805);}
 function touch({player:p,objectId,definition}){const id=definition?.id??objectId;if(id!==STONE||stage(p)!==820||!sessions.has(p))return false;const a=sessions.get(p);if(a.viewing)return true;a.viewing=true;p.getCombat().reset();p.getMovementQueue().setBlockMovement(true);play(p,MOVARIO,'into-the-chasm-touching-the-stone-of-jas');return true;}
 function startDemons(a){
  const p=a.player;advance(p,850);a.started=false;p.getMovementQueue().setBlockMovement(false);
  for(const n of [...a.cast])remove(a,n);replace(p,PLINTH,[4139,4383,0]);
  for(const s of COMBAT_SKILLS)p.getSkillManager().setCurrentLevel(s,255,true);
  a.demons=DEMONS.map((id,i)=>{const n=spawn(a,id,4130+i*15,4386,600);demonStates.set(n,{style:i,prayer:0,damage:0,nextAttack:a.ticks+6,switchAt:a.ticks+27});n.setHeadIcon(0);n.performGraphic(new Graphic(2847));return n;});
  a.idria=spawn(a,IDRIA,4133,4381);spawn(a,GUARDIAN,4131,4381);spawn(a,GUARDIAN,4135,4381);p.sendMessage('The Stone of Jas fills you with extraordinary strength. The Guardians of Armadyl join the battle.');
 }
 function processDemons(a){
  const p=a.player;
  for(const n of a.demons){
   if(!alive(n))continue;const s=demonStates.get(n);
   if(a.ticks%8===0)n.getCombat().getHitQueue().addPendingDamage([new HitDamage(4,HitMask.RED)]);
   if(a.ticks>=s.switchAt){const choices=[0,1,2].filter(i=>!p.getPrayerActive()[PRAYERS[i]]);s.style=choices[random(0,choices.length-1)];s.switchAt=a.ticks+27;}
   if(a.ticks<s.nextAttack||!sight(a,n))continue;s.nextAttack=a.ticks+6;
   n.performAnimation(new Animation([11392,11389,11388][s.style]));hit(p,p.getPrayerActive()[PRAYERS[s.style]]?0:random(0,31));
   if(a.ticks%48<6){const tile=p.getLocation().clone();api.core.CombatFactory.freeze(p,2);n.performAnimation(new Animation(11387));a.flame={tile,tick:a.ticks+4};}
  }
  if(a.flame&&a.ticks>=a.flame.tick){if(p.getLocation().equals(a.flame.tile))hit(p,random(15,31));a.flame=null;}
  if(a.demons.every(n=>!alive(n))){advance(p,880);p.getCombat().reset();a.idria.forceChat('That was astounding!');p.sendMessage('Both tormented demons have been defeated. Speak to Idria.');}
 }
 function modify({npc,hit:h}){
  const p=h.getAttacker(),a=sessions.get(p);if(!a)return;const style=STYLES.indexOf(h.getCombatType());
  if(npc===a.boss){if(a.protection.includes(style))h.setTotalDamage(0);else if(h.getTotalDamage()>0)a.lastStyle=style;return;}
  const s=demonStates.get(npc);if(!s)return;if(s.prayer===style)h.setTotalDamage(0);else{
   // Quest demons retain their shield; the Stone's boost supplies the damage.
   const weapon=weaponName(p),spell=p.getCombat().getCastSpell()??p.getCombat().getSelectedSpell();
   if(!DEMONBANE.includes(weapon)&&!weapon.startsWith('abyssal')&&!BANE_SPELLS.includes(spell))h.setTotalDamage(Math.floor(h.getTotalDamage()*0.8));s.damage+=h.getTotalDamage();if(s.damage>=150){s.damage=0;s.prayer=style;npc.setHeadIcon(style);}
  }
 }
 function death({npc}){const p=npc.getOwner?.(),a=p&&sessions.get(p);if(a&&npc===a.boss){advance(p,820);afterBalance(a);p.sendMessage('The Balance Elemental falls. Touch the Stone of Jas.');}}
 function action({player:p,stepId}){const a=sessions.get(p);if(!a)return;if(stepId==='KzHwbD')startBalance(a);if(stepId==='hgivty')spawn(a,LUCIEN,4144,4383);if(stepId==='JXzCsk')startDemons(a);if(stepId==='8jJyHQ'&&stage(p)===880)p.moveTo(loc(2989,3343));}
 function idria({player:p,npcId}){if(npcId!==IDRIA||stage(p)!==880||!sessions.has(p))return false;play(p,npcId,'into-the-chasm-talking-to-idria-after-killing-the-tormented-demons');return true;}
 function login({player:p}){const l=p.getLocation();if(stage(p)<900&&l.getX()>=4096&&l.getX()<=4159&&l.getY()>=4352&&l.getY()<=4419)p.moveTo(new Location(3229,9527,2));}
 // shortcut: use the shared floor-loot death system at the rim until server deaths support gravestones.
 function deathDrop(e){if(!sessions.has(e.player)||!e.dropEligible)return;api.core.ItemOnGroundManager.registerLocation(e.player,e.item,new Location(3229,9527,2),null);e.handled=true;}
 api.onCustomEvent('wgs:approach-stone',enter);
 api.onCustomEvent('npc-dialogue:action',action);
 api.onObjectInteraction('Stone of Jas',{Touch:touch});
 api.onNpcInteraction('Idria',{'Talk-to':idria});
 api.onNpcHitModify(modify);
 api.onNpcDeath(death);
 api.onPlayerDeathItemDrop(deathDrop);
 api.onPlayerLogin(login);
 return {StoneArea,enter,modify,protect,processDemons,startDemons,sessions,demonStates};
};
