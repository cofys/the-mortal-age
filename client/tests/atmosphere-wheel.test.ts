import assert from "node:assert/strict";
import { processWidgetScrollWheelInput } from "../game/widgets/input/widgetScrollWheelInput";
import { InputManager } from "../game/InputManager";

// A screen effect mounted on overlay_atmosphere (the Last Man Standing fog tint, br_overlay:1 on
// 164:1) is drawn over the scene but never takes the wheel from the camera zoom.
let invoked: number[] = [];
const deps: any = { getCs2Vm: () => ({ context: { getViewportFovValues() {} }, invokeEventHandler: (widget: any) => invoked.push(widget.uid) }), executeScriptListener: (widget: any) => invoked.push(widget.uid) };
const mounts = new Map<number, number>([[328, (164 << 16) | 1], [500, (164 << 16) | 16]]);
const manager: any = { isEffectivelyHidden: () => false, getContainerUidForGroup: (group: number) => mounts.get(group) };
const viewport = { uid: 1, type: 0, eventHandlers: { onScroll: { scriptId: 39 } } };
const scroll = (hits: any[]) => {
    invoked = [];
    const input = new InputManager();
    input.wheelDeltaY = 120;
    processWidgetScrollWheelInput(deps, { input, mx: 20, my: 20, hits } as any, manager, { isDraggingWidget: false } as any);
};
const fog = { uid: (328 << 16) | 1, groupId: 328, type: 3, filled: true, transparency: 100 };
scroll([viewport, fog]);
assert.deepEqual(invoked, [1], "the fog tint leaves the camera zoom to the viewport");
const modalRectangle = { uid: (500 << 16) | 3, groupId: 500, type: 3, transparency: 0 };
scroll([viewport, modalRectangle]);
assert.deepEqual(invoked, [], "a rectangle in a modal still blocks it");
console.log("atmosphere wheel ok");
