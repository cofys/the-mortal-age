import assert from "node:assert/strict";

import { WidgetTransmitProcessor } from "../game/widgets/WidgetTransmitProcessor";
import { Cs2Vm } from "../rs/cs2/Cs2Vm";
import { Opcodes } from "../rs/cs2/Opcodes";
import { createHandlerMap } from "../rs/cs2/handlers";
import { WidgetManager } from "../widgets/WidgetManager";

const ROOT = 161;
function widget(groupId: number, fileId: number, parentUid = -1, timer?: number): any {
    return {
        uid: (groupId << 16) | fileId, groupId, fileId, parentUid, type: 0,
        rawX: 0, rawY: 0, rawWidth: 0, rawHeight: 0, hidden: false,
        ...(timer === undefined ? {} : { onTimer: [timer] }),
    };
}
const root = widget(ROOT, 0, -1, 10);
const secondRoot = widget(ROOT, 1, -1, 11);
const container = widget(ROOT, 2, root.uid);
const staticTimer = widget(ROOT, 3, container.uid, 12);
const mount = widget(ROOT, 4, root.uid);
const subRoot = widget(300, 0, -1, 20);
const subTimer = widget(300, 1, subRoot.uid, 21);
const dormantRoot = widget(301, 0, -1, 30);
const all = [root, secondRoot, container, staticTimer, mount, subRoot, subTimer, dormantRoot];
for (let i = 5; i < 1005; i++) all.push(widget(ROOT, i, root.uid));
const groups = new Map<number, any>();
for (const groupId of [ROOT, 300, 301]) {
    const nodes = all.filter(node => node.groupId === groupId);
    groups.set(groupId, { root: nodes[0], widgets: new Map(nodes.map(node => [node.uid, node])) });
}
const manager = new WidgetManager({} as never, {
    loadWidgetGroup: (groupId: number) => groups.get(groupId),
    getAvailableGroups: () => [...groups.keys()], clearCache() {},
} as never);
manager.setRootInterface(ROOT);
manager.openSubInterface(mount.uid, 300);
manager.getGroup(301);
const queued: any[] = [];
const immediate: any[] = [];
const processor = new WidgetTransmitProcessor({
    getWidgetManager: () => manager, getTransmitCycles: () => ({}) as any,
    getCs2Vm: () => ({ runScriptEvent: (event: any) => immediate.push(event.args) }) as any,
    queueScriptEvent: (event, priority) => { assert.equal(priority, 1); queued.push(event); },
    executeScriptListener() {},
});
function tick(): number[] {
    queued.length = 0;
    processor.processWidgetTimers();
    return queued.map(event => event.args[0]);
}

assert.deepEqual(tick(), [20, 21, 11, 10, 12], "mounted and multi-root timers keep DFS queue order");
let scans = 0;
const getStatic = manager.getStaticChildrenByParentUid.bind(manager);
manager.getStaticChildrenByParentUid = (uid: number) => { scans++; return getStatic(uid); };
for (let i = 0; i < 20; i++) assert.deepEqual(tick(), [20, 21, 11, 10, 12]);
assert.equal(scans, 0, "warm timer ticks must not rescan the 1,000 unrelated widget nodes");

container.hidden = true;
mount.hidden = true;
assert.deepEqual(tick(), [11, 10], "hidden ancestors and mount containers suppress their timers");
container.hidden = false;
mount.hidden = false;
staticTimer.isHidden = true;
assert.deepEqual(tick(), [20, 21, 11, 10, 12], "timer visibility keeps the existing hidden-field semantics");
assert.equal(scans, 0, "hide/show only checks cached ancestor paths");

const vm = new Cs2Vm({ widgetManager: manager, loadScript: () => undefined } as any);
function setTimer(node: any, scriptId: number, byUid = false): void {
    vm.intStackSize = vm.stringStackSize = 0;
    vm.pushInt(scriptId);
    vm.pushString("");
    if (byUid) {
        vm.pushInt(node.uid);
        vm.setEventHandlerByUid("onTimer");
    } else vm.setEventHandler(node, "onTimer");
}
setTimer(staticTimer, 13);
assert.deepEqual(tick(), [20, 21, 11, 10, 13], "CC timer replacement reads the new script immediately");
assert.equal(queued.at(-1).timerArgsSnapshot, staticTimer.onTimer, "queued-event cancellation retains its args snapshot");
setTimer(subTimer, 22, true);
assert.deepEqual(tick(), [20, 22, 11, 10, 13], "IF timer replacement updates the existing indexed node");
assert.equal(scans, 0, "replacing args on an existing timer keeps the cached traversal");
setTimer(staticTimer, -1);
assert.deepEqual(tick(), [20, 22, 11, 10], "CC clearing removes a cache-loaded listener");
setTimer(staticTimer, 14, true);
assert.deepEqual(tick(), [20, 22, 11, 10, 14], "IF adding a listener invalidates membership");
setTimer(subTimer, -1, true);
assert.deepEqual(tick(), [20, 11, 10, 14], "IF clearing removes its listener");

const otherMount = all.find(node => node.groupId === ROOT && node.fileId === 5);
const duplicateMount = all.find(node => node.groupId === ROOT && node.fileId === 6);
manager.openSubInterface(otherMount.uid, 301);
manager.openSubInterface(duplicateMount.uid, 300);
duplicateMount.hidden = true;
assert.deepEqual(tick(), [30, 20, 11, 10, 14], "a hidden duplicate mount cannot suppress an earlier visible instance");
duplicateMount.hidden = false;
assert.deepEqual(tick(), [20, 30, 11, 10, 14], "visible duplicate mounts retain original reverse-mount queue order without double firing");
manager.closeSubInterface(duplicateMount.uid);
manager.closeSubInterface(otherMount.uid);

// Exercise the real create/copy/delete opcodes and their WidgetManager registration paths.
const handlers = createHandlerMap();
const context = (vm as any).createHandlerContext();
function op(opcode: number, args: number[] = []): void {
    vm.intStackSize = 0;
    for (const value of args) vm.pushInt(value);
    handlers.get(opcode)!(context, 0, null);
}
op(Opcodes.CC_CREATE, [container.uid, 0, 0, 0]);
let dynamic = vm.activeWidget!;
setTimer(dynamic, 40);
assert.deepEqual(tick(), [20, 11, 10, 40, 14], "dynamic timers run before static children as before");
op(Opcodes.CC_COPY, [container.uid, 0, 2]);
const copied = vm.activeWidget!;
assert.deepEqual(tick(), [20, 11, 10, 40, 40, 14], "copied timer listeners are indexed without a setter");
assert.equal(queued[3].widget, dynamic);
assert.equal(queued[4].widget, copied);
op(Opcodes.CC_DELETE);
assert.deepEqual(tick(), [20, 11, 10, 40, 14], "deleting a timer removes its cached entry");
op(Opcodes.CC_CREATE, [dynamic.uid, 0, 0, 0]);
setTimer(vm.activeWidget!, 41);
assert.deepEqual(tick(), [20, 11, 10, 40, 41, 14]);
op(Opcodes.CC_CREATE, [container.uid, 0, 0, 0]);
assert.deepEqual(tick(), [20, 11, 10, 14], "overwriting a dynamic container drops its entire timer subtree");
assert.equal(manager.getWidgetByUid(dynamic.uid), undefined, "replaced dynamic children are unregistered");
dynamic = vm.activeWidget!;
setTimer(dynamic, 40);
tick();

// A mouse-following script rebuilds non-timer descendants every frame. This must not
// invalidate the timer index, or the next tick would still walk the whole gameframe.
scans = 0;
for (let i = 0; i < 5; i++) {
    op(Opcodes.CC_CREATE, [dynamic.uid, 4, 0, 0]);
    const rebuilt = vm.activeWidget!;
    assert.deepEqual(tick(), [20, 11, 10, 40, 14]);
    vm.setActiveWidget(rebuilt);
    op(Opcodes.CC_DELETE);
}
assert.equal(scans, 0, "non-timer child churn does not force full-tree timer scans");
vm.setActiveWidget(container);
op(Opcodes.CC_CREATECHILD, [0, 0]);
assert.deepEqual(tick(), [20, 11, 10, 14], "create-child also unregisters an overwritten timer");
setTimer(vm.activeWidget!, 42);
tick();
op(Opcodes.CC_CREATESIBLING, [0, 0]);
assert.deepEqual(tick(), [20, 11, 10, 14], "create-sibling also unregisters an overwritten timer");
setTimer(vm.activeWidget!, 43);
tick();
op(Opcodes.CC_DELETEALL, [container.uid]);
assert.deepEqual(tick(), [20, 11, 10, 14], "delete-all removes nested dynamic timer subtrees");

setTimer(staticTimer, 4725);
tick();
processor.runMouseFollowingTimers(10, 10);
processor.runMouseFollowingTimers(10, 10);
assert.deepEqual(immediate, [[4725]], "mouse-following work still runs once per pointer move");
container.hidden = true;
processor.runMouseFollowingTimers(11, 10);
assert.equal(immediate.length, 1, "hiding an ancestor between ticks stops its mouse timer");
container.hidden = false;
setTimer(subRoot, 4725);
tick();
manager.closeSubInterface(mount.uid);
processor.runMouseFollowingTimers(12, 10);
assert.equal(immediate.length, 2, "closing a mount between ticks stops its cached mouse timer");
assert.deepEqual(tick(), [11, 10, 4725], "closed mounted groups stop queuing events");
manager.openSubInterface(mount.uid, 300);
assert.deepEqual(tick(), [4725, 11, 10, 4725], "reopening a cached group restores its timers");

// Handler-object listeners, including string/object args, use the same cache.
subRoot.onTimer = undefined;
subRoot.eventHandlers = { onTimer: { scriptId: 50, intArgs: [7], objectArgs: ["value"] } };
manager.updateTimerWidget(subRoot);
assert.deepEqual(tick(), [50, 11, 10, 4725]);
assert.deepEqual(queued[0].args, [50, 7, "value"]);
manager.updateTimerWidget({ ...subRoot, onTimer: [99] });
assert.deepEqual(tick(), [50, 11, 10, 4725], "detached script targets cannot replace the registered timer entry");

manager.setRootInterface(301);
assert.deepEqual(tick(), [30], "switching root drops old root and mounted timers");
manager.unloadGroup(301);
const reloadedRoot = widget(301, 0, -1, 31);
groups.set(301, { root: reloadedRoot, widgets: new Map([[reloadedRoot.uid, reloadedRoot]]) });
assert.deepEqual(tick(), [31], "reloading the active unloaded group indexes fresh listeners");
manager.clear();
assert.deepEqual(tick(), [], "logout clears timer work");

console.log("Warm timer passes: 20,140 full-tree child lookups before; 0 after (same 100 queued events).");

console.log("widget timer index tests passed");
