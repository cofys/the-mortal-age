import assert from "node:assert/strict";

import { ClientState } from "../game/ClientState";
import { widgetEntriesToSimple } from "../ui/menu/MenuBridge";
import { MenuState } from "../ui/menu/MenuState";
import { chooseDefaultMenuEntry } from "../ui/menu/MenuEngine";
import { deriveMenuEntriesForWidget } from "../widgets/menu/utils";
import { buildWidgetActionPayload } from "../game/widgets/widgetActionPayload";
import { createPrimaryWidgetActionResolver } from "../game/widgets/input/widgetPrimaryAction";

ClientState.clearItemSelection();
ClientState.isSpellSelected = false;

let stateAtDispatch: { selected: number; itemId: number } | undefined;
let dispatched: any;
const menuState = new MenuState();
const [use] = widgetEntriesToSimple(
    [{ option: "Use", target: "Test item", widgetAction: { slot: 7, itemId: 4151 } }],
    {
        ui: {
            onWidgetAction: (event: any) => {
                stateAtDispatch = {
                    selected: ClientState.isItemSelected,
                    itemId: ClientState.selectedItemId,
                };
                dispatched = event;
            },
        },
        chosenWidget: { uid: 149 << 16, parentUid: 149 << 16, childIndex: 7, itemId: 4151 },
        scheduleRender: () => undefined,
        menuState,
    },
);

if (typeof use.menuStateIndex === "number") {
    menuState.invoke(use.menuStateIndex, 0, 0, { source: "menu" });
} else {
    use.onClick?.(0, 0, { source: "menu" });
}

assert.deepEqual(stateAtDispatch, { selected: 0, itemId: -1 });
assert.equal(dispatched?.option, "Use");
assert.equal(dispatched?.slot, 7);
assert.equal(dispatched?.itemId, 4151);
assert.equal(use.menuStateIndex, undefined, "widget actions must not run through generic menuAction");

// Cached inventory ops land in widget action slots via enum 4303
// (inv op1..5 -> slots 2,3,4,6,7, i.e. action indices 1,2,3,5,6).
// Pot of flour's only ops are Empty (op4 -> index 5) and Drop, so "Use" is the
// default action. A weapon keeps its op2 Wield (index 2) as primary.
const allOpsVisible = () => -1;
const noWidgetLookup = () => undefined;
const entriesFor = (itemId: number, actions: (string | null)[]) =>
    deriveMenuEntriesForWidget(
        { itemId, actions, targetVerb: "Use" },
        false,
        allOpsVisible,
        noWidgetLookup,
    );
const flour = entriesFor(1933, [null, null, null, null, null, "Empty", "Drop"]);
assert.deepEqual(
    flour.map((entry) => entry.option),
    ["Use", "Empty", "Drop", "Cancel"],
);
assert.equal(chooseDefaultMenuEntry(flour, {})?.option, "Use");
const staff = entriesFor(1381, [null, null, "Wield", null, null, null, "Drop"]);
assert.deepEqual(
    staff.map((entry) => entry.option),
    ["Wield", "Use", "Drop", "Cancel"],
);
assert.equal(chooseDefaultMenuEntry(staff, {})?.option, "Wield");
const shark = entriesFor(385, [null, "Eat", null, null, null, null, "Drop"]);
assert.deepEqual(
    shark.map((entry) => entry.option),
    ["Eat", "Use", "Drop", "Cancel"],
);

// With an item or spell selected, an inventory item offers only the selection's entry.
const selectFor = (actionName: string, name: string, targetMask: number) => {
    ClientState.isSpellSelected = true;
    ClientState.selectedSpellActionName = actionName;
    ClientState.selectedSpellName = name;
    ClientState.selectedSpellTargetMask = targetMask;
};
const logs = { itemId: 1511, name: "Logs", actions: [null, null, null, null, null, null, "Drop"], targetVerb: "Use" };
selectFor("Use", "<col=ff9040>Knife", 0x3f);
assert.deepEqual(deriveMenuEntriesForWidget(logs, false, allOpsVisible, noWidgetLookup), [
    { option: "Use", target: "<col=ff9040>Knife -> <col=ff9040>Logs", opIndex: 0 },
    { option: "Cancel" },
]);
selectFor("Cast", "<col=00ff00>High Level Alchemy</col>", 0x20);
assert.equal(
    deriveMenuEntriesForWidget(logs, false, allOpsVisible, noWidgetLookup)[0]?.target,
    "<col=00ff00>High Level Alchemy</col> -> <col=ff9040>Logs",
);
// A spell that cannot land on items leaves the item's own menu alone.
selectFor("Cast", "<col=00ff00>Wind Strike</col>", 0x06);
assert.deepEqual(
    deriveMenuEntriesForWidget(logs, false, allOpsVisible, noWidgetLookup).map((entry) => entry.option),
    ["Use", "Drop", "Cancel"],
);
ClientState.clearSpellSelection();

console.log("widget menu Use dispatch test passed");

// A cache-script item op called Inspect is not the separate Examine entry.
// Run its real menu derivation, bridge/default selection and packet-payload
// construction, preserving the dynamic child's parent component and slot.
for (const widget of [
    { uid: (149 << 16) + 32770, parentUid: 149 << 16, fileId: -1, childIndex: 2,
        itemId: 32926, name: 'Serving platter', targetVerb: 'Use', actions: [null, 'Inspect', null, null, null, null, 'Destroy'] },
    { uid: (123 << 16) | 4, groupId: 123, fileId: 4, childIndex: -1,
        itemId: -1, name: 'Status', actions: ['Inspect'] },
]) {
    const packets: any[] = [];
    let details = 0;
    const context = {
        ui: { onWidgetAction: (event: any) => packets.push(buildWidgetActionPayload(undefined, event)),
            onWidgetExamine: () => details++ },
        chosenWidget: widget, scheduleRender: () => undefined,
        label: { includeExamineIds: true },
    };
    const entries = widgetEntriesToSimple(
        deriveMenuEntriesForWidget(widget, false, allOpsVisible, noWidgetLookup), context);
    const inspect = entries.find(entry => entry.option === 'Inspect');
    assert.ok(inspect, 'normal widget flags expose the actual operation');
    assert.equal(chooseDefaultMenuEntry(entries, {}), inspect, 'Inspect remains the primary operation');
    assert.doesNotMatch(inspect.target ?? '', /ID:/, 'only actual Examine gets the debug ID label');
    inspect.onClick?.(0, 0, { source: 'menu' });
    assert.equal(details, 0, 'Inspect must not call the details/examine owner');
    assert.equal(packets.length, 1);
    assert.equal(packets[0].option, 'Inspect');
    assert.equal(packets[0].opId, widget.itemId >= 0 ? 2 : 1);
    assert.equal(packets[0].widgetId, widget.itemId >= 0 ? 149 << 16 : widget.uid);
    if (widget.itemId >= 0) {
        assert.equal(packets[0].slot, 2);
        assert.equal(packets[0].itemId, 32926);
    }
    const manager = {getWidgetFlags:allOpsVisible,getWidgetOpMask:()=>0,getWidgetByUid:noWidgetLookup};
    const resolvePrimary = createPrimaryWidgetActionResolver({
        getSpellSelection:()=>({getWidgetTargetMask:()=>0}),getSettings:()=>({shiftClickEnabled:false}),
    } as any,{isShiftDown:()=>false} as any,manager as any,{} as any);
    const primary = resolvePrimary(widget);
    assert.equal(primary.option,'Inspect','the actual primary input owner must not replace Inspect with Use');
    assert.equal(primary.opIndex,widget.itemId >= 0 ? 2 : 1);
    const primaryPacket = buildWidgetActionPayload(manager as any,{widget,...primary,source:'primary'});
    assert.equal(primaryPacket?.opId,widget.itemId >= 0 ? 2 : 1);
    if (widget.itemId >= 0) {
        assert.equal(primaryPacket?.slot,2);assert.equal(primaryPacket?.itemId,32926);
    }
    const [examine] = widgetEntriesToSimple([{option:'Examine',target:'Serving platter'}], context);
    examine.onClick?.();
    assert.equal(details, 1, 'separate Examine retains the details owner');
    assert.equal(packets.length, 1, 'Examine cannot send a widget operation');
    const [legacyDetails] = widgetEntriesToSimple([{option:'Inspect',target:'Debug details'}], context);
    legacyDetails.onClick?.();
    assert.equal(details, 2, 'metadata-less debug Inspect keeps its existing details fallback');
    assert.equal(packets.length, 1);
}
console.log('native widget Inspect operation and separate Examine paths passed');

// A submenu label differs from its parent: Configure -> Inspect must preserve
// the parent's native op and supply the selected sub-operation, not Examine.
{
    const widget = {uid:(123 << 16) | 5, groupId:123, fileId:5, childIndex:-1,
        itemId:-1, name:'Status', actions:['Configure'], submenuActions:[['Inspect','Other details']]};
    const packets: any[] = [];
    let details = 0;
    const [configure] = widgetEntriesToSimple(
        deriveMenuEntriesForWidget(widget, false, allOpsVisible, noWidgetLookup), {
            ui:{onWidgetAction:(event:any)=>packets.push(buildWidgetActionPayload(undefined,event)),
                onWidgetExamine:()=>details++}, chosenWidget:widget, scheduleRender:()=>undefined,
        });
    const subEntries = configure.subEntries!;
    assert.equal(subEntries.length,2);
    subEntries[1].onClick?.(0,0,{source:'menu'});
    subEntries[0].onClick?.(0,0,{source:'menu'});
    assert.equal(details,0);
    assert.deepEqual(packets.map(packet=>[packet.option,packet.opId,packet.subOpId]),[
        ['Other details',1,2],['Inspect',1,1],
    ]);
}
console.log('native Inspect submenu dispatch passed');
