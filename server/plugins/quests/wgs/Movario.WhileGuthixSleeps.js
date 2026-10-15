/** Movario's base: cache scene coordinates and OSRS Wiki puzzle rules. */
module.exports = function registerMovario({api,quest,stage,advance,held,give,val,replace,hit,ATTRIBUTES}) {
  const {Location,PrivateArea,Boundary,ItemDefinition,Bank}=api.core;
  const RUNE_ATTRIBUTE='while-guthix-sleeps:door-rune';
  const WIRES_ATTRIBUTE='while-guthix-sleeps:wires';
  const STAIRS_ATTRIBUTE='while-guthix-sleeps:stairs-safe';
  const BOOKCASE_ATTRIBUTE='while-guthix-sleeps:bookcase-open';
  const BED_ATTRIBUTE='while-guthix-sleeps:bed-chest';
  const READ_ATTRIBUTE='while-guthix-sleeps:notes-read';
  const PAINTING_ATTRIBUTE='while-guthix-sleeps:painting-open';
  const GAUGE_ATTRIBUTE='while-guthix-sleeps:pressure-gauge';
  const WEIGHTS_ATTRIBUTE='while-guthix-sleeps:statue-weights';
  const TRIES_ATTRIBUTE='while-guthix-sleeps:door-tries';
  const RESOURCES_ATTRIBUTE='while-guthix-sleeps:base-resources';
  const RESOURCES=[[53959,53955,10793,453],[53965,53961,10794,554],[53971,53967,10795,560],[53977,53973,10796,1513]];
  const BASE_ATTRIBUTE='while-guthix-sleeps:in-base';
  ATTRIBUTES.push(RESOURCES_ATTRIBUTE,RUNE_ATTRIBUTE,WIRES_ATTRIBUTE,STAIRS_ATTRIBUTE,BOOKCASE_ATTRIBUTE,BED_ATTRIBUTE,READ_ATTRIBUTE,PAINTING_ATTRIBUTE,GAUGE_ATTRIBUTE,WEIGHTS_ATTRIBUTE,TRIES_ATTRIBUTE,BASE_ATTRIBUTE);
  const NOTES=[29525,29526], KEY=29523, BASKET=29522, PRESSURE_NOTES=29524;
  const RUNES=[556,557,554,555,558], WEIGHTS=[29527,29528,29529], KILOS=[1,2,5];
  const ENTRY_LADDER=53892, DOWN_STAIRS=53895, UP_STAIRS=53896, RUNE_CHEST=54117;
  const RUNEDOOR=53901, BACK_DOOR=53902, RUNE_DOORS=[53903,53904,53905,53906,53907];
  const BOOKCASES=[53914,53915,53916,53917,53918,53919,53920];
  const ELECTRIC_GATE=53921, SAFE_GATE=53922, SPIRAL=53924, SPIRAL_TOP=53927;
  const DESK=53941, EMPTY_DESK=53940, WASTE_BASKET=53938, RUBY_BOOKCASE=53939;
  const MECHANICAL_STAIRS=53947, SMALL_STAIRS=53948, BED=53949, CHESTS=[53950,53951,53952,53953];
  const PAINTING=53885, WALL=53884, GAUGE=53937, DRAWERS=53936, PILE=53935;
  const STATUES=[53928,53929,53930,53931,53932,53933], EXIT=53897;
  const areas=new WeakMap();
  function weight(p){
    let grams=0;
    for(const items of [p.getInventory().getItems(),p.getEquipment().getItems()])for(const item of items){
      if(item&&item.getId()>=0&&item.getAmount()>0)grams+=(Number(item.getDefinition().getWeight())||0)*item.getAmount();
    }
    return Math.floor(grams/1000);
  }
  class MovarioArea extends PrivateArea {
    constructor(player){super([0,1,2].map(z=>new Boundary(4096,4223,4928,4991,z)));this.player=player;this.guards=[];}
    canTeleport(p){return val(p,TRIES_ATTRIBUTE)!==3&&p.getLocation().getX()>=4160?false:null;}
    postLeave(mobile,logout){if(mobile===this.player){for(const n of this.guards)api.removeNpc(n);for(const o of [...this.getObjects()])api.core.ObjectManager.deregister(o,true);areas.delete(mobile);mobile.setAttribute(BASE_ATTRIBUTE,0);if(logout)mobile.moveTo(new Location(2519,3248,0));}super.postLeave(mobile,logout);}
  }
  function enter({player}){
    const area=new MovarioArea(player);areas.set(player,area);area.enter(player);player.setAttribute(BASE_ATTRIBUTE,1);
    player.moveTo(new Location(4147,4954,0));
    for(const[id,x,y]of [[13531,4144,4954],[13532,4137,4947],[13533,4128,4959],[13534,4120,4974]]){
      const n=api.spawnNpc({id,x,y,z:0,wanderRadius:2,owner:player,ownerOnly:true});area.enter(n);area.guards.push(n);
    }
    restoreScenery(player);
  }
  function active(p){return areas.has(p)&&stage(p)>=100;}
  function resources(p){let claimed=p.getAttribute(RESOURCES_ATTRIBUTE);if(!Array.isArray(claimed)){claimed=[0,0,0,0];p.setAttribute(RESOURCES_ATTRIBUTE,claimed);}return claimed;}
  function resourceVars(p){const claimed=resources(p);RESOURCES.forEach((r,i)=>p.getPacketSender().sendVarbit(r[2],100-claimed[i]));}
  function tunnel({player,object,objectId,definition}){
    if(!active(player)||(definition?.id??objectId)!==53942)return false;
    player.moveTo(new Location(4173,object.getLocation().getY()===4948?4937:4949,1));return true;
  }
  function takeResource({player,objectId,definition}){
    if(!active(player))return false;const id=definition?.id??objectId;
    const index=RESOURCES.findIndex(([parent,first])=>id===parent||(id>=first&&id<=first+3));if(index<0)return false;
    const claimed=resources(player),item=RESOURCES[index][3],inventory=player.getInventory(),remaining=100-claimed[index];
    const stackable=ItemDefinition.forId(item).isStackable(),amount=stackable?(inventory.contains(item)||inventory.getFreeSlots()?remaining:0):Math.min(remaining,inventory.getFreeSlots());
    if(amount<=0){player.sendMessage(remaining?'You need a free inventory space.':'The pallet is empty.');return true;}
    const before=inventory.getAmount(item);inventory.adds(item,amount);claimed[index]+=inventory.getAmount(item)-before;
    player.setAttribute(RESOURCES_ATTRIBUTE,claimed);resourceVars(player);return true;
  }
  function restoreScenery(p){
    resourceVars(p);
    if(val(p,BOOKCASE_ATTRIBUTE))replace(p,MECHANICAL_STAIRS,[4172,4954,1],10,3);
    if(val(p,BED_ATTRIBUTE))replace(p,val(p,BED_ATTRIBUTE)>=3?CHESTS[2]:CHESTS[1],[4179,4954,2],10,1);
    if(val(p,PAINTING_ATTRIBUTE))replace(p,WALL,[4179,4948,1],4,3);
    for(let i=0;i<7;i++)p.getPacketSender().sendVarbit(10763+i,val(p,WIRES_ATTRIBUTE)>i?1:0);
    p.getPacketSender().sendVarbit(10797,val(p,WIRES_ATTRIBUTE)>=7?1:0);
    p.getPacketSender().sendVarbit(10856,val(p,RUNE_ATTRIBUTE)?[1,2,5,3,4][val(p,RUNE_ATTRIBUTE)-1]:0);
  }
  function route(event){
    const {player,sourceLocation}=event,objectId=event.definition?.id??event.objectId;
    if(!active(player))return;
    const z=player.getLocation().getZ();
    if(objectId===WALL)event.destination={x:4179,y:sourceLocation.y>=4948?4949:4946,z};
    if([ELECTRIC_GATE,SAFE_GATE].includes(objectId)&&val(player,WIRES_ATTRIBUTE)>=7)event.destination={x:4181,y:sourceLocation.y>=4953?4954:4952,z};
  }
  function ladder({player,objectId,definition}){objectId=definition?.id??objectId;if(objectId!==ENTRY_LADDER||!active(player))return false;player.moveTo(new Location(2519,3248,0));return true;}
  function stairs({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player))return false;
    if(objectId===DOWN_STAIRS)player.moveTo(new Location(4210,4981,0));
    else if(objectId===UP_STAIRS)player.moveTo(new Location(4116,4971,0));
    else if(objectId===SPIRAL){if(!val(player,STAIRS_ATTRIBUTE)){hit(player,18);player.sendMessage('A trap springs from the staircase! Search it before climbing.');return true;}player.moveTo(new Location(4180,4950,1));}
    else if(objectId===SPIRAL_TOP)player.moveTo(new Location(4180,4950,0));
    else if(objectId===MECHANICAL_STAIRS&&val(player,BOOKCASE_ATTRIBUTE))player.moveTo(new Location(4173,4954,2));
    else if(objectId===SMALL_STAIRS)player.moveTo(new Location(4173,4954,1));
    else return false;
    return true;
  }
  function backDoor({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||objectId!==BACK_DOOR)return false;
    player.moveTo(new Location(4210,4981,0));return true;
  }
  function inspectDoor({player,objectId,definition}){
    objectId=definition?.id??objectId;
    if(!active(player)||![RUNEDOOR,...RUNE_DOORS].includes(objectId))return false;
    if(!val(player,RUNE_ATTRIBUTE))player.setAttribute(RUNE_ATTRIBUTE,1+Math.floor(Math.random()*5));
    player.sendMessage(`The word PROHIBITED has a symbol resembling a ${['air','earth','fire','water','mind'][val(player,RUNE_ATTRIBUTE)-1]} rune in place of one letter.`);return true;
  }
  function runeDoor({player,objectId,itemId}){
    objectId=api.core.ObjectDefinition.forPlayer(objectId,player)?.id??objectId;
    if(!active(player)||![RUNEDOOR,...RUNE_DOORS].includes(objectId))return false;
    if(!RUNES.includes(itemId))return false;
    if(!val(player,RUNE_ATTRIBUTE))inspectDoor({player,objectId});
    if(itemId!==RUNES[val(player,RUNE_ATTRIBUTE)-1]){hit(player,20+Math.floor(Math.random()*10));player.sendMessage('The incorrect rune triggers a blast of magic.');return true;}
    if(weight(player)<2){player.sendMessage('You are too light to depress the floor. You must weigh at least 2 kg.');return true;}
    player.getInventory().deleteNumber(itemId,1);player.moveTo(new Location(4181,4964,0));return true;
  }
  function bookcase({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||!BOOKCASES.includes(objectId))return false;
    const index=BOOKCASES.indexOf(objectId),progress=val(player,WIRES_ATTRIBUTE);
    if(progress>=7){player.sendMessage('The electric gate is already deactivated.');return true;}
    if(index!==progress){player.sendMessage('You find no lever here. Follow the illuminated floor wire.');return true;}
    player.setAttribute(WIRES_ATTRIBUTE,progress+1);player.getPacketSender().sendVarbit(10763+index,1);
    if(progress===6){player.getPacketSender().sendVarbit(10797,1);player.sendMessage('The electric gate is deactivated.');}
    else player.sendMessage('You hear a click as you pull a lever. A floor wire illuminates.');return true;
  }
  function gate({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||![ELECTRIC_GATE,SAFE_GATE].includes(objectId))return false;
    if(val(player,WIRES_ATTRIBUTE)<7){hit(player,20);player.sendMessage('The live gate gives you an electric shock.');return true;}
    const p=player.getLocation();player.moveTo(new Location(4181,p.getY()>=4953?4952:4954,0));return true;
  }
  function search({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player))return false;
    if(objectId===RUNE_CHEST){for(const id of RUNES)give(player,id,5);return true;}
    if(objectId===SPIRAL){player.setAttribute(STAIRS_ATTRIBUTE,1);player.sendMessage('You find and disable a trap in the stairs.');return true;}
    if([DESK,EMPTY_DESK].includes(objectId)){give(player,NOTES[0]);return true;}
    if(objectId===RUBY_BOOKCASE){player.sendMessage('There is a ruby-coloured lock in this bookcase.');return true;}
    if(objectId===BED){player.setAttribute(BED_ATTRIBUTE,1);replace(player,CHESTS[1],[4179,4954,2],10,1);player.sendMessage('There is a chest hidden beneath the bed.');return true;}
    if(CHESTS.includes(objectId)){
      if(val(player,BED_ATTRIBUTE)<2){player.sendMessage('The bed chest is locked.');return true;}
      if(val(player,BED_ATTRIBUTE)===2){player.setAttribute(BED_ATTRIBUTE,3);player.sendMessage('You disable the trap in the bed chest.');return true;}
      if(val(player,BED_ATTRIBUTE)===3){player.sendMessage('The chest is safe. Open it first.');return true;}
      give(player,NOTES[1]);return true;
    }
    if(objectId===DRAWERS){give(player,PRESSURE_NOTES);return true;}
    return false;
  }
  function openChest({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||!CHESTS.includes(objectId))return false;
    if(val(player,BED_ATTRIBUTE)<2){player.sendMessage('The bed chest is locked.');return true;}
    if(val(player,BED_ATTRIBUTE)<3){hit(player,18+Math.floor(Math.random()*10));player.sendMessage('A trap springs from the chest! Search it before opening.');return true;}
    player.setAttribute(BED_ATTRIBUTE,4);replace(player,CHESTS[2],[4179,4954,2],10,1);return true;
  }
  function ruby({player,itemId,objectId}){
    objectId=api.core.ObjectDefinition.forPlayer(objectId,player)?.id??objectId;
    if(itemId!==KEY||!active(player))return false;
    if(objectId===RUBY_BOOKCASE){player.setAttribute(BOOKCASE_ATTRIBUTE,1);replace(player,MECHANICAL_STAIRS,[4172,4954,1],10,3);player.sendMessage('The bookcase moves aside to reveal stairs.');return true;}
    if(CHESTS.includes(objectId)&&val(player,BED_ATTRIBUTE)){player.setAttribute(BED_ATTRIBUTE,Math.max(2,val(player,BED_ATTRIBUTE)));return true;}return false;
  }
  function painting({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||objectId!==PAINTING)return false;
    api.sendMultiChatboxPrompt(player,'A lever is hidden behind the painting.','Pull the lever.',()=>{player.setAttribute(PAINTING_ATTRIBUTE,1);replace(player,WALL,[4179,4948,1],4,3);},'Leave it.',()=>{});return true;
  }
  function cross({player,objectId,definition}){objectId=definition?.id??objectId;if(!active(player)||objectId!==WALL)return false;player.moveTo(new Location(4179,player.getLocation().getY()>4948?4946:4949,1));return true;}
  function gauge({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||objectId!==GAUGE)return false;
    if(!val(player,GAUGE_ATTRIBUTE))player.setAttribute(GAUGE_ATTRIBUTE,5+Math.floor(Math.random()*36));
    player.sendMessage(`The pressure gauge reads ${val(player,GAUGE_ATTRIBUTE)+val(player,WEIGHTS_ATTRIBUTE)} tickits. Your equipment weight is ${weight(player)} kg.`);return true;
  }
  function takeWeight(player,id){if(!player.getInventory().getFreeSlots()){player.sendMessage('You need a free inventory space.');return;}player.getInventory().adds(id,1);}
  function pile({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||objectId!==PILE)return false;
    api.sendMultiChatboxPrompt(player,'Choose a weight.','1 kg',()=>takeWeight(player,WEIGHTS[0]),'2 kg',()=>takeWeight(player,WEIGHTS[1]),'5 kg',()=>takeWeight(player,WEIGHTS[2]));return true;
  }
  function statue({player,itemId,objectId}){
    objectId=api.core.ObjectDefinition.forPlayer(objectId,player)?.id??objectId;
    if(!active(player)||!WEIGHTS.includes(itemId)||!STATUES.includes(objectId))return false;
    player.getInventory().deleteNumber(itemId,1);player.setAttribute(WEIGHTS_ATTRIBUTE,val(player,WEIGHTS_ATTRIBUTE)+KILOS[WEIGHTS.indexOf(itemId)]);player.sendMessage('You add the weight to the statue.');return true;
  }
  function exit({player,objectId,definition}){objectId=definition?.id??objectId;
    if(!active(player)||objectId!==EXIT)return false;
    if(player.getLocation().getX()<4160){const p=player.getLocation();player.moveTo(new Location(p.getX(),p.getY()>4955?4954:4956,0));return true;}
    if(!val(player,GAUGE_ATTRIBUTE))gauge({player,objectId:GAUGE});
    if(weight(player)!==val(player,GAUGE_ATTRIBUTE)+val(player,WEIGHTS_ATTRIBUTE)){
      const tries=(val(player,TRIES_ATTRIBUTE)+1)%3;player.setAttribute(TRIES_ATTRIBUTE,tries);
      if(tries){player.sendMessage(`The door stays locked. ${3-tries} attempts remain.`);return true;}
      for(const id of NOTES){player.getInventory().deleteNumber(id,player.getInventory().getAmount(id));for(let tab=0;tab<Bank.TOTAL_BANK_TABS;tab++){const bank=player.getBank(tab);bank.deleteNumber(id,bank.getAmount(id));}}
      player.sendMessage('Gas fills the room. You wake in a jail cell, and your research notes have been confiscated.');player.moveTo(new Location(4128,4938,0));return true;
    }
    player.setAttribute(TRIES_ATTRIBUTE,3);player.moveTo(new Location(4188,4953,1));player.sendMessage('The weights balance and the eastern door unlocks. You can now teleport out.');return true;
  }
  function item(event){
    const {player,itemId,option}=event;
    if(itemId===BASKET&&option==='Search'){event.handled=true;give(player,KEY);return true;}
    if(itemId===PRESSURE_NOTES&&option==='Read'){event.handled=true;player.sendMessage('Match your equipment weight to the pressure gauge. Add weights to yourself or to the statue. Three wrong attempts trigger the gas trap.');return true;}
    if(!NOTES.includes(itemId)||option!=='Read')return false;
    event.handled=true;
    const pages=itemId===NOTES[0]?['Movario has been researching the history of Guthix and the God Wars.','An object known as the Stone of Jas has enormous power.','Movario believes the stone was hidden after the God Wars.']:['Movario has detected a magical signature near Lumbridge.','The Stone of Jas may be buried beneath the swamps.','Movario intends to investigate the underground caverns.'];
    function page(index){player.sendMessage(pages[index]);api.sendMultiChatboxPrompt(player,`Movario\'s notes — page ${index+1} of ${pages.length}`,index+1<pages.length?'Next page.':'Finish reading.',()=>{if(index+1<pages.length)page(index+1);else player.setAttribute(READ_ATTRIBUTE,val(player,READ_ATTRIBUTE)|(1<<NOTES.indexOf(itemId)));},'Close.',()=>{});}page(0);return true;
  }
  function basket({player,objectId,definition}){objectId=definition?.id??objectId;if(!active(player)||objectId!==WASTE_BASKET)return false;give(player,BASKET);return true;}
  function login({player}){const l=player.getLocation();if(val(player,BASE_ATTRIBUTE)||(l.getX()>=4096&&l.getX()<=4223&&l.getY()>=4928&&l.getY()<=4991)){player.setAttribute(BASE_ATTRIBUTE,0);player.moveTo(new Location(2519,3248,0));}}
  api.onCustomEvent('wgs:enter-movario',enter);
  api.onObjectRoute(route);
  api.onObjectInteraction('Ladder',{Climb:ladder});
  api.onObjectInteraction('Stairs',{'Climb-down':stairs,'Climb-up':stairs});
  api.onObjectInteraction('Spiral staircase',{'Climb-up':stairs,'Climb-down':stairs,Search:search});
  api.onObjectInteraction('Old battered door',{Inspect:inspectDoor,Open:backDoor});
  api.onObjectInteraction('Bookcase',{Search:bookcase});
  api.onObjectInteraction('Bookcase',{Search:search});
  api.onObjectInteraction('Gate',{Open:gate});
  api.onObjectInteraction('Chest',{Search:search});
  api.onObjectInteraction('Desk',{Search:search});
  api.onObjectInteraction('Waste-paper basket',{'Pick-up':basket});
  api.onObjectInteraction('Bed',{Search:search});
  api.onObjectInteraction('Bed chest',{Search:search,Open:openChest});
  api.onObjectInteraction('Painting',{Inspect:painting});
  api.onObjectInteraction('Broken wall',{'Cross-over':cross});
  api.onObjectInteraction('Drawers',{Search:search});
  api.onObjectInteraction('Pressure gauge',{Check:gauge});
  api.onObjectInteraction('Pile of weights',{'Take-from':pile});
  api.onObjectInteraction('Door',{Open:exit});
  api.onObjectInteraction('Tunnel',{Enter:tunnel});
  for(const name of ['Coal pile','Fire rune pile','Death rune pile','Magic logs pile'])api.onObjectInteraction(name,{'Take-from':takeResource});
  for(const name of ['Air rune','Earth rune','Fire rune','Water rune','Mind rune'])api.onItemOnObject(name,'Old battered door',runeDoor,{noted:false});
  api.onItemOnObject('Ruby key','Bookcase',ruby,{noted:false});
  api.onItemOnObject('Ruby key','Bed chest',ruby,{noted:false});
  for(const name of ['Weight (1kg)','Weight (2kg)','Weight (5kg)'])api.onItemOnObject(name,'Statue',statue,{noted:false});
  api.onItemAction(item);
  api.onPlayerLogin(login);
};
