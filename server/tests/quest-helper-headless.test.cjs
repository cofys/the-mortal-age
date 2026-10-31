const {test}=require('node:test');
const assert=require('node:assert/strict');
const {QuestHelperRuntime}=require('../plugins/quests/questhelper/Runtime.QuestHelper');
const {collectQuestHelperSnapshot,resolveTargets,sceneBase}=require('../plugins/quests/questhelper/Snapshot.QuestHelper');

const bridgeResult=request=>({protocol:1,session:request.session,sequence:request.sequence,questKey:request.questKey,sourceCommit:'pinned',status:'active',activeStep:{id:'step-1',text:['Talk to the cook'],targets:[]},panels:[],diagnostics:[]});

function fixture() {
 const calls=[],closed=[],sent=[];
 const quest={key:'cooks_assistant',name:"Cook's Assistant",varpId:29,getStage:()=>1,isStarted:()=>true,isComplete:()=>false,varpValue:s=>s};
 const other={key:'the_final_dawn',name:'The Final Dawn',varbitId:16663,getStage:()=>4,isStarted:()=>true,isComplete:()=>false,varbitValue:()=>4};
 const player={getAttribute:()=>0,getIndex:()=>7,getInventory:()=>({getItems:()=>[]}),getEquipment:()=>({getItems:()=>[]}),getLocation:()=>({getX:()=>3206,getY:()=>3213,getZ:()=>0}),getUsername:()=> 'Fixture'};
 const bridge={
  catalog:async()=>({sourceCommit:'pinned',quests:[{questKey:quest.key,supported:true},{questKey:other.key,supported:true,helperVariant:'main'}],diagnostics:[]}),
  evaluate:async request=>{calls.push(request);return bridgeResult(request);},
  close:async session=>closed.push(session),
 };
 const runtime=new QuestHelperRuntime({getQuests:()=>[quest,other],bridge,send:(_p,d)=>sent.push(d)});
 const send=data=>runtime.receive(player,{protocol:1,session:'browser-session',...data});
 return {runtime,player,quest,other,calls,closed,sent,send,bridge};
}
const headless=(f,questKey,extra={})=>f.runtime.evaluateHeadless(f.player,{questKey,snapshot:{localPlayer:{},varps:{29:999}},events:[],...extra});

test('headless evaluation uses server truth and reports both sides',async()=>{
 const f=fixture();
 const result=await headless(f,'cooks_assistant');
 assert.equal(result.status,'active');assert.equal(result.questKey,'cooks_assistant');
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].sequence,1);
 assert.equal(f.calls[0].snapshot.varps[29],1,'saved stage overrides the supplied varp');
 assert.equal(f.calls[0].snapshot.localPlayer.x,3206);
 assert.deepEqual(result.questProgress.map(r=>r.stage),[1,4]);
 const row=f.runtime.describe(f.player,'cooks_assistant');
 assert.deepEqual(row.wire,{kind:'varp',id:29,value:1});
 assert.equal(f.runtime.describe(f.player,'the_final_dawn').wire.kind,'varbit');
 assert.equal(f.runtime.lastAgentResult(f.player).result.activeStep.id,'step-1');
});

test('headless sessions park per quest and only reselect when the route changes',async()=>{
 const f=fixture();
 await headless(f,'cooks_assistant');
 await headless(f,'cooks_assistant');
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].sequence,2);
 assert.equal(f.calls[0].session,f.calls[1].session,'same quest keeps its engine session');
 await headless(f,'the_final_dawn');
 assert.equal(f.closed.length,1);
 assert.notEqual(f.calls[2].session,f.calls[1].session,'a new route gets a new engine session');
 await headless(f,'the_final_dawn',{fresh:true});
 assert.equal(f.closed.length,2);
 assert.notEqual(f.calls[3].session,f.calls[2].session);
});

test('headless evaluation rejects an unknown route and an unknown quest',async()=>{
 const f=fixture();
 await assert.rejects(headless(f,'nope'),/Unknown quest nope/);
 await assert.rejects(headless(f,'the_final_dawn',{helperVariant:'invented'}),/Unknown helper variant/);
 await assert.rejects(headless(f,'the_final_dawn',{snapshot:null}),/Invalid helper snapshot/);
 await assert.rejects(headless(f,'the_final_dawn',{events:[{}]}),/Invalid helper events/);
 assert.equal(f.calls.length,0);
});

test('a native route still answers when the bridge never started',async()=>{
 const calls=[];
 const quest={key:'recipe_for_disaster',name:'Recipe for Disaster',varpId:1850,getStage:()=>4,isStarted:()=>true,isComplete:()=>false,varpValue:()=>4};
 const bridge={catalog:async()=>{throw new Error('Quest Helper engine has not been started');},evaluate:async r=>{calls.push(r);throw new Error('unreachable');},close:async()=>{}};
 const runtime=new QuestHelperRuntime({getQuests:()=>[quest],bridge,send:()=>{},nativeResult:()=>({status:'active',activeStep:{id:'tsps-native-rfd-v1',text:['Rescue Pirate Pete']},diagnostics:[]})});
 const result=await runtime.evaluateHeadless({getAttribute:()=>0,getInventory:()=>({getItems:()=>[]}),getEquipment:()=>({getItems:()=>[]}),getLocation:()=>({getX:()=>3206,getY:()=>3213,getZ:()=>0}),getUsername:()=>'Fixture'},{questKey:quest.key,snapshot:{localPlayer:{}}});
 assert.equal(result.activeStep.id,'tsps-native-rfd-v1');
 assert.equal(calls.length,0,'the bridge is never asked');
});

test('the client result is tapped without changing what the browser receives',async()=>{
 const f=fixture();
 await f.send({type:'catalog'});
 await f.send({type:'select',questKey:'cooks_assistant'});
 await f.send({type:'evaluate',questKey:'cooks_assistant',sequence:1,snapshot:{localPlayer:{}},events:[]});
 const emitted=f.sent.filter(d=>d.type==='result');
 assert.equal(emitted.length,1);
 const tapped=f.runtime.lastResult(f.player);
 assert.equal(tapped.result.activeStep.id,emitted[0].activeStep.id);
 assert.equal(tapped.result.questKey,'cooks_assistant');
 assert.equal(f.runtime.lastAgentResult(f.player),null);
 await headless(f,'cooks_assistant');
 assert.notEqual(f.calls.at(-1).session,emitted[0].session,'headless and browser never share an engine session');
 assert.equal(f.runtime.lastResult(f.player).result.activeStep.id,'step-1');
});

function scenePlayer(overrides={}) {
 const at={x:3206,y:3214,z:0,...overrides};
 return {
  getLocation:()=>({getX:()=>at.x,getY:()=>at.y,getZ:()=>at.z}),getIndex:()=>7,getUsername:()=>'Fixture',
  getInventory:()=>({getItems:()=>[{getId:()=>1933,getAmount:()=>1}]}),getEquipment:()=>({getItems:()=>[]}),
  getFrameUpdater:()=>({interfaceTextMap:new Map([[65536,{currentState:'Hello'}]])}),
 };
}
const sceneDeps=nearby=>({
 nearby,tick:()=>42,items:container=>container.getItems().map((item,slot)=>({slot,id:item.getId(),amount:item.getAmount()})),
 skills:()=>({HITPOINTS:{real:10,boosted:10,xp:1154}}),
});
const scene=()=>({
 npcs:[{index:1,id:2,name:'Cook',x:3206,y:3215,z:0,animation:3,combatLevel:5,interactingIndex:-1}],
 objects:[{id:9,name:'Door',x:3205,y:3214,z:0,type:0}],
 groundItems:[{id:995,name:'Coins',amount:5,x:3207,y:3214,z:0}],
});

test('the snapshot uses the client scene base and the bridge field names',()=>{
 const snapshot=collectQuestHelperSnapshot(sceneDeps(scene),scenePlayer());
 assert.equal(snapshot.baseX,3152);assert.equal(snapshot.baseY,3160);
 assert.equal(snapshot.plane,0);assert.equal(snapshot.tick,42);
 assert.equal(snapshot.localPlayer.index,7);
 assert.deepEqual(snapshot.npcs,[{index:1,ecsIndex:1,id:2,transformedId:2,name:'Cook',x:3206,y:3215,plane:0,animation:3,orientation:0,combatLevel:5,interactingIndex:-1}]);
 assert.deepEqual(snapshot.objects,[{id:9,x:3205,y:3214,plane:0,type:0,orientation:0}]);
 assert.deepEqual(snapshot.groundItems,[{id:995,quantity:5,x:3207,y:3214,plane:0}]);
 assert.deepEqual(snapshot.inventory,[{id:1933,quantity:1,slot:0}]);
 assert.deepEqual(snapshot.widgets,[{id:65536,text:'Hello'}]);
 assert.deepEqual(snapshot.skills,{HITPOINTS:{real:10,boosted:10,xp:1154}});
 assert.equal(snapshot.instanceTemplateChunks,undefined);
 assert.equal(snapshot.hintArrowNpcIndex,-1);
});

test('the scene base always contains the player tile',()=>{
 for (const x of [0,1,7,8,9,3206,4095,12345,16383]) {
  const base=sceneBase(x);
  assert.ok(x>=base&&x<base+104,`${x} outside ${base}..${base+104}`);
 }
});

test('template instances supply the chunk palette and boats do not',()=>{
 const palette=[[[123]],[[-1]]];
 const instance=scenePlayer();
 instance.getPrivateArea=()=>({buildScenePalette:()=> ({palette,xteas:[]})});
 assert.equal(collectQuestHelperSnapshot(sceneDeps(scene),instance).instanceTemplateChunks,palette);
 const deck=scenePlayer();
 deck.getPrivateArea=()=>({countsAsMainWorld:()=>true});
 assert.equal(collectQuestHelperSnapshot(sceneDeps(scene),deck).instanceTemplateChunks,undefined);
});

test('every mapped widget survives the bridge protocol shape',()=>{
 const player=scenePlayer();
 player.getFrameUpdater=()=>({interfaceTextMap:new Map()});
 assert.deepEqual(collectQuestHelperSnapshot(sceneDeps(scene),player).widgets,[]);
 const noUpdater=scenePlayer();
 noUpdater.getFrameUpdater=undefined;
 assert.deepEqual(collectQuestHelperSnapshot(sceneDeps(scene),noUpdater).widgets,[]);
});

test('targets resolve against the cache, the scene and the containers',()=>{
 const snapshot={localPlayer:{x:10,y:10},inventory:[{id:100}],equipment:[],npcs:[{id:2,x:10,y:11,plane:0}],objects:[{id:9,x:5,y:5,plane:0}],groundItems:[{id:200,x:10,y:10,plane:0}]};
 const known=new Set([2,9,100]);
 const resolved=resolveTargets([
  {kind:'npc',id:2,x:10,y:11,plane:0},
  {kind:'object',id:9,x:5,y:5,plane:0},
  {kind:'object',id:9,x:99,y:99,plane:0},
  {kind:'item',id:100},
  {kind:'item',id:200},
  {kind:'item',id:999},
  {kind:'tile',x:1,y:2,plane:0},
 ],snapshot,(kind,id)=>kind==='tile'||known.has(id));
 assert.deepEqual(resolved.map(t=>[t.kind,t.scene,t.cache]),[
  ['npc','on-tile','known'],['object','on-tile','known'],['object','absent','known'],
  ['item','carried','known'],['item','on-ground','missing'],['item','absent','missing'],['tile','n/a','n/a'],
 ]);
});

const {contractFor,contractState}=require('../plugins/quests/questhelper/Contract.QuestHelper');

function questCache(rows) {
 return {
  getDbColumns:()=>['id','sortname','displayname','endstate'],
  getDbTableRows:()=>rows.map(([id,name,endstate])=>({id,string:()=>name,int:()=>endstate})),
 };
}

test('the cache completion contract is the independent anchor for the wire',()=>{
 const cache=questCache([[14,'Clock Tower',8],[12,'The Final Dawn',68]]);
 assert.deepEqual(contractFor(cache,'Clock Tower'),{rowId:14,name:'Clock Tower',endstate:8});
 assert.deepEqual(contractFor(cache,'final dawn'),{rowId:12,name:'The Final Dawn',endstate:68},'articles are ignored');
 assert.equal(contractFor(cache,'Not A Quest'),null);
 assert.equal(contractFor(questCache([]),'Clock Tower'),null);

 const wire={kind:'varp',id:10,value:7};
 assert.deepEqual(contractState(cache,'Clock Tower',wire,false),{rowId:14,endstate:8,completeAt:false,complete:false,agrees:true});
 assert.equal(contractState(cache,'Clock Tower',{...wire,value:8},false).agrees,false,'wire says complete, the save does not');
 assert.equal(contractState(cache,'Clock Tower',{...wire,value:8},true).agrees,true);
 assert.equal(contractState(cache,'Clock Tower',null,true).agrees,null,'no wire, no verdict');
 assert.equal(contractState(cache,'Unknown Quest',wire,true),null);
});

test('a cache without quest rows reports no contract instead of guessing',()=>{
 assert.equal(contractFor(undefined,'Clock Tower'),null);
 assert.equal(contractFor({},'Clock Tower'),null);
 assert.equal(contractFor({getDbColumns:()=>{throw new Error('no cache');},getDbTableRows:()=>{throw new Error('no cache');}},'Clock Tower'),null);
});

test('describe carries the contract and flags a disagreement',async()=>{
 const f=fixture();
 const describe=f.runtime.describe(f.player,'cooks_assistant');
 assert.equal(describe.contract,null,'no cache wired in');
 const cache=questCache([[1,"Cook's Assistant",5]]);
 const runtime=new QuestHelperRuntime({getQuests:()=>[f.quest],bridge:{catalog:async()=>({quests:[]}),evaluate:async()=>({}),close:async()=>{}},send:()=>{},
  contract:(name,wire,complete)=>contractState(cache,name,wire,complete)});
 const row=runtime.describe(f.player,'cooks_assistant');
 assert.equal(row.stage,1);
 assert.deepEqual(row.contract,{rowId:1,endstate:5,completeAt:false,complete:false,agrees:true});
 const done=new QuestHelperRuntime({getQuests:()=>[{...f.quest,getStage:()=>5,varpValue:()=>5,isComplete:()=>true}],bridge:{},send:()=>{},
  contract:(name,wire,complete)=>contractState(cache,name,wire,complete)});
 assert.equal(done.describe(f.player,'cooks_assistant').contract.agrees,true);
 const lying=new QuestHelperRuntime({getQuests:()=>[{...f.quest,varpValue:()=>5}],bridge:{},send:()=>{},
  contract:(name,wire,complete)=>contractState(cache,name,wire,complete)});
 assert.equal(lying.describe(f.player,'cooks_assistant').contract.agrees,false,'wire complete but stage 1');
});

const {classify,fillRequested}=require('../plugins/quests/questhelper/Requests.QuestHelper');

test('requested state is split into what the server can answer and what it cannot',()=>{
 assert.deepEqual(classify([{kind:'varbit',id:1788},{kind:'varbitDefinition',id:1788},{kind:'geometry',id:0},{kind:'itemDefinitions',id:5}]).varbits,[1788]);
 assert.deepEqual(classify([{kind:'geometry',id:0},{kind:'objectDefinitions',id:7}]).unsupported,[{kind:'geometry',id:0},{kind:'objectDefinitions',id:7}]);
 assert.deepEqual(classify([{kind:'varbit',id:-1},{kind:'varbit',id:'x'},null]).varbits,[]);
 assert.equal(classify(undefined).varbits.length,0);
});

test('a requested varbit is filled with its cache definition and packs into its varp',()=>{
 const read={varbit:id=>id===1788?1:Number.NaN,definition:id=>id===1788?{baseVar:33,startBit:1,endBit:1}:null};
 const filled=fillRequested({varbits:{},varbitDefinitions:{}}, [{kind:'varbit',id:1788},{kind:'geometry',id:0}], read);
 assert.deepEqual(filled.snapshot.varbits,{1788:1});
 assert.deepEqual(filled.snapshot.varbitDefinitions,{1788:{varp:33,lsb:1,msb:1}});
 assert.deepEqual(filled.ids,[1788]);
 assert.deepEqual(filled.unsupported,[{kind:'geometry',id:0}]);
 assert.equal(fillRequested({varbits:{}}, [{kind:'varbit',id:9999}], {varbit:()=>0,definition:()=>null}),null,'no definition, no guess');
 assert.equal(fillRequested({varbits:{}}, [{kind:'geometry',id:0}], {varbit:()=>0,definition:()=>null}),null);
});

test('a headless call answers MISSING_STATE and evaluates again',async()=>{
 const f=fixture();
 const asked=[{kind:'varbit',id:1788},{kind:'varbitDefinition',id:1788}];
 let round=0;
 f.bridge.evaluate=async request=>{
  f.calls.push(request);round+=1;
  if(round===1)return {protocol:1,session:request.session,sequence:request.sequence,status:'unavailable',activeStep:null,diagnostics:[{code:'MISSING_STATE',method:'varbit',message:'Snapshot requires varbit 1788'}],requests:asked};
  return bridgeResult(request);
 };
 const runtime=new QuestHelperRuntime({getQuests:()=>[f.quest],bridge:f.bridge,send:()=>{},
  varbitDefinition:id=>id===1788?{baseVar:33,startBit:1,endBit:1}:undefined,
  fillRequests:(_player,requests,snapshot)=>fillRequested(snapshot,requests,{varbit:()=>1,definition:id=>id===1788?{baseVar:33,startBit:1,endBit:1}:null})});
 const result=await runtime.evaluateHeadless(f.player,{questKey:'cooks_assistant',snapshot:{localPlayer:{},varps:{},varbits:{}}});
 assert.equal(f.calls.length,2,'asked once, answered, asked again');
 assert.equal(f.calls[1].sequence,f.calls[0].sequence+1,'the retry is a new sequence');
 assert.equal(f.calls[0].snapshot.varbits[1788],undefined,'the first request carried no value');
 assert.equal(f.calls[1].snapshot.varbits[1788],1,'the retry carries the server value');
 assert.deepEqual(f.calls[1].snapshot.varbitDefinitions[1788],{varp:33,lsb:1,msb:1});
 assert.equal(f.calls[1].snapshot.varps[33],2,'authoritative() packs the varbit back into varp 33');
 assert.equal(result.activeStep.id,'step-1');
 assert.equal(result.requestsFilled,1);
 assert.equal(result.requestsUnresolved,undefined);
});

test('unanswerable requests are reported instead of looping',async()=>{
 const f=fixture();
 f.bridge.evaluate=async request=>{f.calls.push(request);return {status:'unavailable',activeStep:null,requests:[{kind:'geometry',id:0}]};};
 const runtime=new QuestHelperRuntime({getQuests:()=>[f.quest],bridge:f.bridge,send:()=>{},
  fillRequests:(_p,requests,snapshot)=>fillRequested(snapshot,requests,{varbit:()=>0,definition:()=>null})});
 const result=await runtime.evaluateHeadless(f.player,{questKey:'cooks_assistant',snapshot:{localPlayer:{}}});
 assert.equal(f.calls.length,1,'nothing to fill, nothing to retry');
 assert.deepEqual(result.requestsUnresolved,[{kind:'geometry',id:0}]);

 // A bridge that always asks for the same value it was just given learns nothing new and stops
 // immediately rather than burning the whole budget.
 const stuck=fixture();
 stuck.bridge.evaluate=async request=>{stuck.calls.push(request);return {status:'unavailable',activeStep:null,requests:[{kind:'varbit',id:1788}]};};
 const stuckRuntime=new QuestHelperRuntime({getQuests:()=>[stuck.quest],bridge:stuck.bridge,send:()=>{},
  fillRequests:(_p,requests,snapshot)=>fillRequested(snapshot,requests,{varbit:()=>1,definition:()=>({baseVar:33,startBit:1,endBit:1})})});
 const stuckResult=await stuckRuntime.evaluateHeadless(stuck.player,{questKey:'cooks_assistant',snapshot:{localPlayer:{}}});
 assert.equal(stuck.calls.length,2,'the repeated ask is reported, not retried');
 assert.equal(stuckResult.requestsFilled,1);
 assert.deepEqual(stuckResult.requestsUnresolved,[{kind:'varbit',id:1788}]);

 // The worst case measured across the pinned helpers: 55 distinct varbits in one quest file
 // (Mourning's End Part II). One round each, all in one call.
 const chain=fixture();
 const ids=[...Array(55)].map((_,index)=>3000+index);
 chain.bridge.evaluate=async request=>{
  chain.calls.push(request);
  const missing=ids.find(id=>request.snapshot.varbits[id]===undefined);
  return missing===undefined
   ?bridgeResult(request)
   :{status:'unavailable',activeStep:null,requests:[{kind:'varbit',id:missing}]};
 };
 const chainRuntime=new QuestHelperRuntime({getQuests:()=>[chain.quest],bridge:chain.bridge,send:()=>{},
  varbitDefinition:()=>({baseVar:500,startBit:0,endBit:15}),
  fillRequests:(_p,requests,snapshot)=>fillRequested(snapshot,requests,{varbit:id=>id-3000,definition:()=>({baseVar:500,startBit:0,endBit:15})})});
 const chainResult=await chainRuntime.evaluateHeadless(chain.player,{questKey:'cooks_assistant',snapshot:{localPlayer:{}}});
 assert.equal(chain.calls.length,ids.length+1,'one round per value, one call');
 assert.equal(chainResult.activeStep.id,'step-1');
 assert.equal(chainResult.requestsFilled,ids.length);

 // The same chain on a second call costs one evaluation, because the values are remembered.
 const before=chain.calls.length;
 await chainRuntime.evaluateHeadless(chain.player,{questKey:'cooks_assistant',snapshot:{localPlayer:{}}});
 assert.equal(chain.calls.length,before+1,'a later call does not walk the chain again');
});
