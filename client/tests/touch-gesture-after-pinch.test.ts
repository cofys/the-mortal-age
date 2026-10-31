import assert from "node:assert/strict";

import { ClickMode, InputManager } from "../game/InputManager";
import { processWidgetDragInput } from "../game/widgets/input/widgetDragInput";
import { processWidgetReleaseInput } from "../game/widgets/input/widgetReleaseInput";
import { TouchGestureRecognizer } from "../game/input/TouchGestureRecognizer";

const types = (intents: Array<{ type: string }>) => intents.map((intent) => intent.type);

// An ordinary stationary touch taps.
const plain = new TouchGestureRecognizer();
plain.fingerDown(100, 100, 0);
assert.ok(types(plain.fingerUp(100, 100, 50)).includes("tap"));

// The finger left on the screen after a pinch: lifting it ends the pinch, it is no tap...
const afterPinch = new TouchGestureRecognizer();
afterPinch.fingerDown(100, 100, 0, true);
assert.deepEqual(types(afterPinch.checkLongPress(10_000)), [], "nor a long-press");
const lifted = types(afterPinch.fingerUp(100, 100, 50));
assert.ok(!lifted.includes("tap"), `no tap: ${lifted}`);

// ...and the next ordinary touch taps again.
afterPinch.fingerDown(100, 100, 100);
assert.ok(types(afterPinch.fingerUp(100, 100, 150)).includes("tap"));

// Item gestures hold LEFT across frames; world gestures continue to orbit.
const item = new TouchGestureRecognizer();
assert.deepEqual(types(item.fingerDown(100, 100, 0, false, true)), ["move", "widgetPress"]);
assert.deepEqual(types(item.fingerMove(160, 100, 200)), ["move"]);
assert.deepEqual(types(item.checkLongPress(1000)), [], "an item being dragged cannot open the menu");
assert.deepEqual(types(item.fingerUp(160, 100, 1100)), ["move", "widgetRelease"]);
item.fingerDown(100, 100, 0, false, true);
assert.deepEqual(types(item.checkLongPress(500)), ["cancel", "longPress"], "holding still cancels the pending left click before the menu");
item.cancel();
item.fingerDown(100, 100, 0);
assert.ok(types(item.fingerMove(160, 100, 200)).includes("orbitStart"));

function touchInput() {
    const input: any = new InputManager();
    input.element = { width: 800, height: 400,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) };
    input.onCanvasTouchStart = () => true;
    const touch = (x = 100, y = 100) => ({ clientX: x, clientY: y, target: input.element });
    const event = (touches: unknown[], changedTouches = touches) => ({ touches, changedTouches, preventDefault() {} });
    return { input, touch, event };
}

{
    const { input, touch, event } = touchInput();
    input.onTouchStart(event([touch()]));
    input.onFrameStart();
    assert.equal(input.leftClickX, 100);
    input.onFrameEnd();
    assert.equal(input.isDragging(), true, "the item stays held after its first UI frame");
    input.onTouchMove(event([touch(160)]));
    assert.equal(input.mouseWheelDown, false, "item movement never starts camera orbit");
    assert.equal(input.isTouchScrolling, false, "item movement never starts list scrolling");

    const source = { uid: 149 << 16, childIndex: 0, itemId: 315, dragThreshold: 6, dragZoneSize: 5, width: 36, height: 32, _absX: 90, _absY: 90 };
    const target = { uid: (149 << 16) | 1, childIndex: 1, itemId: -1 };
    const moves: number[][] = [];
    const interaction: any = {
        clickedWidget: source, clickedWidgetParent: null, clickedWidgetX: 10, clickedWidgetY: 10,
        dragClickCycle: 0, dragClickX: 100, dragClickY: 100, isDraggingWidget: false,
        isWidgetDraggable: () => true, resolveClickedWidgetParent: () => null,
        getUiRenderScale: () => [1, 1], clearDragWidgetVisualState() {},
        clearWidgetInteractionState() { this.clickedWidget = null; },
    };
    const deps: any = {
        getTransmitCycles: () => ({ cycleCntr: 10 }),
        getCs2Vm: () => ({ invokeEventHandler() {} }),
        handleInventorySlotMove: (from: number, to: number) => moves.push([from, to]),
    };
    const frame: any = { mx: 160, my: 100, allRoots: [], visibleMap: new Map(), getStaticChildren: () => [], getInterfaceParentRoots: () => [] };
    const manager: any = { getWidgetByUid: () => null };
    processWidgetDragInput(deps, frame, manager, interaction, input.isDragging());
    assert.equal(interaction.isDraggingWidget, true, "the touch reaches the existing widget drag path");
    interaction.draggedOnWidget = target;
    input.onTouchEnd(event([], [touch(160)]));
    assert.equal(input.isDragging(), false);
    processWidgetReleaseInput(deps, frame, manager, interaction, () => { throw Error("drag is not an item action"); }, input.isDragging());
    assert.deepEqual(moves, [[0, 1]], "release swaps the source and destination inventory slots once");
}

for (const cancel of ["pinch", "touchcancel"]) {
    const { input, touch, event } = touchInput();
    let cleared = 0;
    input.onCanvasTouchCancel = () => cleared++;
    input.onTouchStart(event([touch()]));
    input.onFrameStart();
    input.onTouchMove(event([touch(160)]));
    if (cancel === "pinch") input.onTouchStart(event([touch(160), touch(200)]));
    else input.onTouchCancel(event([]));
    assert.equal(cleared, 1, `${cancel} clears the pending item action without dropping it`);
    assert.equal(input.isDragging(), false);
    assert.equal(input.clickMode1, ClickMode.NONE);
    assert.equal(input.clickMode3, ClickMode.NONE);
}

{
    const { input, touch, event } = touchInput();
    input.onTouchStart(event([touch()]));
    input.onTouchEnd(event([], [touch()]));
    input.onFrameStart();
    assert.equal(input.leftClickX, 100, "an item tap between frames retains its click");
    assert.equal(input.isDragging(), true);
    input.onFrameEnd();
    assert.equal(input.isDragging(), false, "the tap releases after one frame");
}

console.log("Touch gesture after pinch test passed");
