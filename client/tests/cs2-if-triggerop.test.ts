import { strict as assert } from "node:assert";

import { Cs2Vm } from "../rs/cs2/Cs2Vm";
import { Opcodes } from "../rs/cs2/Opcodes";
import { Script } from "../rs/cs2/Script";
import { registerWidgetOps } from "../rs/cs2/handlers/WidgetOps";
import type { HandlerMap } from "../rs/cs2/handlers/HandlerTypes";

// if_triggerop(component, slot, op): three ints. The report form's submit (script 5105) ends with
// if_triggerop(reportabuse:close, -1, 1) to click its own Close button; popping only two left the
// op on the stack and threw, so the form never closed.
const handlers: HandlerMap = new Map();
registerWidgetOps(handlers);
const trigger = handlers.get(Opcodes.IF_TRIGGEROP)!;
assert.ok(trigger);

const close = { uid: (875 << 16) | 23, children: null };
const row = { uid: ((875 << 16) | 9) | 0, childIndex: 2 };
const list = { uid: (875 << 16) | 9, children: [null, null, row] };
const widgets = new Map<number, any>([[close.uid, close], [list.uid, list]]);
const queued: Array<[any, number]> = [];
const run = (ints: number[]) => {
    const ctx = {
        intStack: Int32Array.from(ints),
        intStackSize: ints.length,
        widgetManager: { getWidgetByUid: (uid: number) => widgets.get(uid) ?? null },
        queueTriggerOp: (widget: any, op: number) => queued.push([widget, op]),
    } as any;
    trigger(ctx, 0, null);
    return ctx.intStackSize;
};

assert.equal(run([close.uid, -1, 1]), 0, "all three ints are popped");
assert.deepEqual(queued, [[close, 1]], "slot -1 is the component itself");
queued.length = 0;
assert.equal(run([list.uid, 2, 3]), 0);
assert.deepEqual(queued, [[row, 3]], "a slot picks the child at that index");
assert.throws(() => run([close.uid, -1, 11]), /RuntimeException/, "ops are 1-10");
assert.throws(() => run([12345, -1, 1]), /RuntimeException/, "an unknown component throws");

// A triggered op is a click: besides the component's onOp listener, an op the server owns (an
// entry in its actions, like Close's op 1) goes to the server as IF_BUTTON, or live's server
// would never see the Close that script 5105 triggers after sending the report.
const sent: Array<[number, number]> = [];
const closeButton = { uid: (875 << 16) | 23, actions: ["Close"], children: null };
const label = { uid: (875 << 16) | 7, actions: [], children: null };
const byUid = new Map<number, any>([[closeButton.uid, closeButton], [label.uid, label]]);
const vm = new Cs2Vm({
    loadScript: () => null,
    varManager: {},
    widgetManager: {
        getWidgetByUid: (uid: number) => byUid.get(uid) ?? null,
        beginBatch() {}, endBatch() {}, flushBatch() {},
    },
    sendWidgetOp: (widget: any, opIndex: number) => sent.push([widget.uid, opIndex]),
} as any);
const triggerScript = (uid: number, op: number) =>
    Object.assign(new Script(), {
        instructions: Int32Array.from([Opcodes.ICONST, Opcodes.ICONST, Opcodes.ICONST, Opcodes.IF_TRIGGEROP, Opcodes.RETURN]),
        intOperands: Int32Array.from([uid, -1, op, 0, 0]),
        stringOperands: [null, null, null, null, null],
    });
vm.execute(triggerScript(closeButton.uid, 1));
assert.deepEqual(sent, [[closeButton.uid, 1]], "Close's op 1 reaches the server");
vm.execute(triggerScript(label.uid, 1));
assert.deepEqual(sent, [[closeButton.uid, 1]], "a component without server ops sends nothing");

console.log("cs2-if-triggerop.test.ts: all tests passed");
