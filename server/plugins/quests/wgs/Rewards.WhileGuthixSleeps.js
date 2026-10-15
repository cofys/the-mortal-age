/** Optional Wiki reward: Kuradal's notes grant Slayer XP once and unlock demonbane crafting. */
module.exports=function registerRewards({api,stage,held,give,val,play,ATTRIBUTES}){
 const {Skill,Bank,Task,TaskManager,HitDamage,HitMask}=api.core;
 const NOTES=29596,KURADAL=13623,RECEIVED='while-guthix-sleeps:duradel-notes',READ='while-guthix-sleeps:duradel-notes-read';
 ATTRIBUTES.push(RECEIVED,READ);
 const SYNAPSE=29580,HAMMER=2347,IRON_BAR=2351,SCORCHING_BOW=29591,PURGING_STAFF=29594,EMBERLIGHT=29589;
 const recipes=[
  {name:'scorching bow',output:SCORCHING_BOW,base:[70],skill:Skill.FLETCHING,ticks:6,made:'while-guthix-sleeps:made-scorching-bow'},
  {name:'purging staff',output:PURGING_STAFF,base:[1391],skill:Skill.CRAFTING,ticks:7,anvil:true,made:'while-guthix-sleeps:made-purging-staff'},
  {name:'Emberlight',output:EMBERLIGHT,base:[19675,30305],skill:Skill.SMITHING,ticks:5,anvil:true,made:'while-guthix-sleeps:made-emberlight'},
 ];
 ATTRIBUTES.push(...recipes.map(r=>r.made));
 const crafting=new WeakSet();
 function possessed(p){return held(p,NOTES)||Array.from({length:Bank.TOTAL_BANK_TABS},(_,i)=>p.getBank(i)).some(bank=>bank.contains(NOTES));}
 function talk({player:p,npcId}){if(npcId!==KURADAL||stage(p)<900)return false;play(p,npcId,'post-quest-dialogue-talking-to-kuradal');return true;}
 function condition({player:p,stepId,pages}){
  if(!['omXWyi','yU0Tl1','lIknwQ','vhO3yX','5OgFOR','zVDDzY'].includes(stepId)||stage(p)<900||!pages?.some(v=>v.page.replace(/^Transcript:/,'')==='While Guthix Sleeps'))return;
  const received=val(p,RECEIVED)||possessed(p)||val(p,READ),lost=received&&!val(p,READ)&&!possessed(p),space=p.getInventory().getFreeSlots()>0;
  return {omXWyi:!received,yU0Tl1:!!received&&!lost,lIknwQ:!!lost,vhO3yX:!space,'5OgFOR':space,zVDDzY:!space}[stepId];
 }
 function action(e){if(e.npcId===KURADAL&&e.stepId==='PGNPip'&&stage(e.player)>=900&&!val(e.player,READ)&&!possessed(e.player)&&give(e.player,NOTES)){e.player.setAttribute(RECEIVED,1);e.box={items:[NOTES]};}}
 function read(e){
  const p=e.player;if(e.itemId!==NOTES||String(e.option).toLowerCase()!=='read'||stage(p)<900)return;e.handled=true;
  if(!held(p,NOTES))return;p.getInventory().deleteNumber(NOTES,1);
  if(val(p,READ))return;p.setAttribute(READ,1);p.setAttribute(RECEIVED,1);
  p.getSkillManager().addExperience(Skill.SLAYER,15*p.getSkillManager().getCurrentLevel(Skill.SLAYER));
  p.sendMessage('Duradel’s notes reveal how to create emberlight, the scorching bow and the purging staff from tormented synapses.');
 }
 function ready(p,r){
  if(stage(p)<900||!val(p,READ)){p.sendMessage('Read Duradel’s notes before working with tormented synapses.');return false;}
  const inv=p.getInventory(),manager=p.getSkillManager();
  if(!held(p,SYNAPSE)||!r.base.some(id=>held(p,id)))return false;
  if(r.anvil&&!held(p,HAMMER)){p.sendMessage('You need a hammer to work at the anvil.');return false;}
  if(r.output===PURGING_STAFF&&(!held(p,IRON_BAR)||manager.getMaxLevel(Skill.SMITHING)<55)){p.sendMessage('You need an iron bar and an unboosted Smithing level of 55.');return false;}
  if(manager.getCurrentLevel(r.skill)<74){
   if(p.getHitpoints()<6){p.sendMessage("I'm not sure I want to try that when I'm this injured.");return false;}
   p.getCombat().getHitQueue().addPendingDamage([new HitDamage(4,HitMask.RED)]);
   p.sendMessage('You burn yourself. You need level 74 '+r.skill.getName()+' to make '+r.name+'.');return false;
  }
  if(r.output===EMBERLIGHT){
   const sword=inv.getItems().find(i=>i&&r.base.includes(i.getId())),s=require('../../items/Arclight.plugin').state(sword);
   if(s.charges+s.infusion<10000){p.sendMessage('Your Arclight needs 10,000 combined charges and infusion to make Emberlight.');return false;}
  }
  return true;
 }
 function craft(p,r){
  if(crafting.has(p)||!ready(p,r))return;
  const inventory=p.getInventory(),synapse=inventory.getItems().find(i=>i?.getId()===SYNAPSE),base=inventory.getItems().find(i=>i&&r.base.includes(i.getId())),origin=p.getLocation().clone();
  crafting.add(p);p.getSkillManager().stopSkillable();p.sendMessage('You begin making '+r.name+'.');
  const task=new Task(r.ticks,p);
  task.execute=()=>{
   task.stop();crafting.delete(p);
   if(!p.isRegistered()||p.getHitpoints()<=0||!p.getLocation().equals(origin)||!inventory.getItems().includes(synapse)||!inventory.getItems().includes(base)||synapse.getId()!==SYNAPSE||!r.base.includes(base.getId())||!ready(p,r))return;
   inventory.deleteNumber(base.getId(),1);if(r.output===PURGING_STAFF)inventory.deleteNumber(IRON_BAR,1);
   synapse.setId(r.output);inventory.refreshItems();
   p.getSkillManager().addExperience(r.skill,val(p,r.made)?73:730);
   if(r.output===PURGING_STAFF)p.getSkillManager().addExperience(Skill.SMITHING,13);
   p.setAttribute(r.made,1);p.sendMessage('You make '+r.name+'.');
  };
  TaskManager.submit(task);
 }
 function pair(e){
  const ids=[e.usedItemId,e.usedWithItemId];if(!ids.includes(SYNAPSE))return;
  const r=recipes.find(r=>r.base.some(id=>ids.includes(id)));if(!r)return;e.handled=true;
  if(r.anvil){e.player.sendMessage('Use the tormented synapse on an anvil to attach it.');return;}
  craft(e.player,r);
 }
 function anvil(e){
  if(e.itemId!==SYNAPSE||api.core.ObjectDefinition.forPlayer(e.objectId,e.player)?.getName()!=='Anvil')return;
  e.handled=true;const available=recipes.filter(r=>r.anvil&&r.base.some(id=>held(e.player,id)));
  if(!available.length){e.player.sendMessage('Bring an Arclight or a battlestaff to work with this synapse.');return;}
  if(available.length===1){craft(e.player,available[0]);return;}
  api.sendMultiChatboxPrompt(e.player,'What would you like to make?',...available.flatMap(r=>[r.name,()=>craft(e.player,r)]));
 }
 function revert({player:p,item}){
  const r=recipes.find(r=>r.output===item.getId());if(!r)return false;
  api.sendMultiChatboxPrompt(p,'Revert this weapon? Only the tormented synapse is returned.','Yes.',()=>{
   if(item.getId()===r.output&&p.getInventory().getItems().includes(item)){item.setId(SYNAPSE);p.getInventory().refreshItems();}
  },'No.',()=>{});
 }
 api.onNpcInteraction('Kuradal',{'Talk-to':talk});api.onNpcDialogueCondition(condition);
 api.onCustomEvent('npc-dialogue:action',action);api.onItemAction(read);
 api.onItemOnItem(pair,{noted:false});api.onItemOnObject(anvil,{noted:false});
 api.onItemAction('Scorching bow',{Revert:revert});api.onItemAction('Purging staff',{Revert:revert});api.onItemAction('Emberlight',{Revert:revert});
 return {condition,action,read,ready,craft,pair,anvil,revert,recipes};
};
