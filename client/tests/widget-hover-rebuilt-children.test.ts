import assert from "node:assert/strict";
import {test} from "node:test";
import {createCacheVm} from "../scripts/cache/cs2-sweep";
import {processWidgetHoverInput} from "../game/widgets/input/widgetHoverInput";

// Active rev241: item_transmog, Present box hat group, actual cache initializer/onOp.
const GROUP=789, HAT_GROUP=25, ACTIVE_OBJ=3703, FESTIVE=30479;
const INIT=6857, CHOICES=(GROUP<<16)|8, ENTRIES=(GROUP<<16)|7;
const SELECTED_GOLD=16750623;
function fixture(){
 const {vm}=createCacheVm();const manager=vm.context.widgetManager;
 manager.getGroup(GROUP);vm.context.varManager.setVarp(ACTIVE_OBJ,FESTIVE);
 vm.run(vm.context.loadScript(INIT),[HAT_GROUP],[]);
 const simple=manager.getDynamicChildrenByParent(CHOICES).find((w:any)=>w.childIndex===1)!;
 const border=()=>manager.getDynamicChildrenByParent(ENTRIES).find((w:any)=>w.childIndex===14)!;
 return {vm,manager,simple,border};
}
function hover(f:ReturnType<typeof fixture>,previous:any[],hits:any[]){
 const state:any={hoveredWidgetUids:new Set(previous.map(w=>w.uid)),hoveredWidgetsByUid:new Map(previous.map(w=>[w.uid,w]))};
 processWidgetHoverInput({getWorldMap:()=>({updateWorldMapIconHover:()=>{}}),getCs2Vm:()=>f.vm} as any,state,{mx:0,my:0,hits} as any,f.manager,{} as any);
 return state;
}
test('stale mouse-leave cannot recolour children rebuilt by a real cache onOp',()=>{
 const f=fixture();f.vm.invokeEventHandler(f.simple,'onOp',{opIndex:1});
 assert.equal(f.border().color,SELECTED_GOLD,'native onOp first selects Simple correctly');
 assert.notEqual(f.manager.getWidgetByUid(f.simple.uid),f.simple,'CC_DELETEALL detached the old child');
 hover(f,[f.simple],[]);assert.equal(f.border().color,SELECTED_GOLD);
});
test('a current live child still gets its normal mouse-leave callback',()=>{
 const f=fixture();f.vm.invokeEventHandler(f.simple,'onOp',{opIndex:1});
 const live=f.manager.getDynamicChildrenByParent(CHOICES).find((w:any)=>w.childIndex===1)!;
 assert.equal(f.manager.getWidgetByUid(live.uid),live);
 hover(f,[live],[]);assert.equal(f.border().color,SELECTED_GOLD);
});
test('a stale hit snapshot cannot dispatch mouse-over/repeat or become current hover state',()=>{
 const f=fixture();f.vm.invokeEventHandler(f.simple,'onOp',{opIndex:1});
 const state=hover(f,[],[f.simple]);
 assert.equal(f.border().color,SELECTED_GOLD);assert.equal(state.hoveredWidgetUids.size,0);
});
