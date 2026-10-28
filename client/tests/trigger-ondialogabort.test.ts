import assert from "node:assert/strict";

import { WidgetManager } from "../widgets/WidgetManager";

// TRIGGER_ONDIALOGABORT runs onDialogAbort on every loaded interface, the root's sub-interfaces
// included: the chatbox's "Enter amount:" prompt sets it on chatbox:mes_text2 (script 108), and
// live's server sends the packet when the bank closes under that prompt.
const widget = (uid: number, extra: object = {}): any => ({
    uid,
    id: uid,
    groupId: uid >>> 16,
    fileId: uid & 0xffff,
    childIndex: -1,
    parentUid: -1,
    isIf3: true,
    type: 0,
    rawX: 0, rawY: 0, rawWidth: 0, rawHeight: 0,
    x: 0, y: 0, width: 0, height: 0,
    widthMode: 1, heightMode: 1, xPositionMode: 0, yPositionMode: 0,
    hidden: false,
    scrollX: 0, scrollY: 0, scrollWidth: 0, scrollHeight: 0,
    ...extra,
});
const root = widget(900 << 16);
const chatbox = widget(162 << 16);
const prompt = widget((162 << 16) | 1, { parentUid: 162 << 16, eventHandlers: { onDialogAbort: { scriptId: 138 } } });
const cacheListener = widget((162 << 16) | 2, { parentUid: 162 << 16, onDialogAbort: [138] });
const groups = new Map<number, Map<number, any>>([
    [900, new Map([[root.uid, root]])],
    [162, new Map([[chatbox.uid, chatbox], [prompt.uid, prompt], [cacheListener.uid, cacheListener]])],
]);
const loader = {
    loadWidgetGroup: (groupId: number) => {
        const widgets = groups.get(groupId)!;
        return { root: widgets.values().next().value, widgets };
    },
    getAvailableGroups: () => [...groups.keys()],
    unloadGroup: () => undefined,
    clearCache: () => undefined,
};
const manager = new WidgetManager({} as never, loader as never);
manager.setRootInterface(900);
manager.openSubInterface(root.uid, 162);

const aborted: number[] = [];
manager.onDialogAbortInvoker = (node) => aborted.push(node.uid);
manager.triggerOnDialogAbort();
assert.deepEqual(aborted.sort((a, b) => a - b), [prompt.uid, cacheListener.uid],
    "runtime and cache-loaded onDialogAbort listeners run; widgets without one are skipped");

console.log("trigger-ondialogabort.test.ts: all tests passed");
