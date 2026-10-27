import assert from "node:assert/strict";

import { WidgetManager } from "../widgets/WidgetManager";

const root: any = {
    uid: 900 << 16,
    id: 900 << 16,
    groupId: 900,
    fileId: 0,
    childIndex: -1,
    parentUid: -1,
    isIf3: true,
    type: 0,
    rawX: 0,
    rawY: 0,
    rawWidth: 0,
    rawHeight: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    widthMode: 1,
    heightMode: 1,
    xPositionMode: 0,
    yPositionMode: 0,
    hidden: false,
    scrollX: 0,
    scrollY: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    onLoad: [123],
    onSubChange: [789],
};
const subRoot = {
    ...root,
    uid: 901 << 16,
    id: 901 << 16,
    groupId: 901,
    onLoad: [456],
    onSubChange: undefined,
};
const nestedRoot = {
    ...subRoot,
    uid: 902 << 16,
    id: 902 << 16,
    groupId: 902,
};
const loader = {
    loadWidgetGroup: (groupId: number) => {
        const group = groupId === 900 ? root : groupId === 901 ? subRoot : nestedRoot;
        return { root: group, widgets: new Map([[group.uid, group]]) };
    },
    getAvailableGroups: () => [900, 901, 902],
    unloadGroup: () => undefined,
    clearCache: () => undefined,
};
const manager = new WidgetManager({} as never, loader as never);
let rootLoads = 0;
manager.onLoadListener = (scriptId) => {
    if (scriptId === 123) rootLoads++;
};
let subChanges = 0;
manager.onSubChangeListener = () => subChanges++;

manager.setRootInterface(900);
manager.openSubInterface(root.uid, 901);
manager.openSubInterface((901 << 16) | 0, 902);
assert.equal(rootLoads, 0);

manager.resize(800, 600);
assert.equal(rootLoads, 1);
assert.equal(root.width, 800);
assert.equal(root.height, 600);
assert.equal(manager.getSubInterface(root.uid)?.group, 901);
assert.equal(manager.getSubInterface((901 << 16) | 0)?.group, 902);
assert.equal(subChanges, 3);

manager.resize(801, 600);
assert.equal(rootLoads, 1);

const closedGroups: number[] = [];
manager.onInterfaceClose = (groupId) => closedGroups.push(groupId);
manager.closeSubInterface(root.uid);
assert.equal(manager.getSubInterface((901 << 16) | 0), undefined,
    "closing a parent also closes its nested sub-interfaces");
assert.deepEqual(closedGroups.sort((a, b) => a - b), [901, 902]);

closedGroups.length = 0;
manager.openSubInterface(root.uid, 901);
manager.setRootInterface(900);
assert.deepEqual(closedGroups.sort((a, b) => a - b), [900, 901]);

closedGroups.length = 0;
manager.clear();
// 902 was unloaded when it closed, so the reset has nothing left to report for it.
assert.deepEqual(closedGroups.sort((a, b) => a - b), [900, 901]);

console.log("Widget root onLoad race test passed");
