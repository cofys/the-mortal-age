import assert from "node:assert/strict";
import { processWidgetScrollWheelInput } from "../game/widgets/input/widgetScrollWheelInput";
import { buildWidgetInputFrame } from "../game/widgets/input/widgetInputSetup";
import { InputManager } from "../game/InputManager";

let invoked: number[] = [];
let grantedWheel = 0;
const deps: any = { getCs2Vm: () => ({ context: { getViewportFovValues() {} }, invokeEventHandler: (widget: any) => invoked.push(widget.uid) }), executeScriptListener: (widget: any) => invoked.push(widget.uid) };
const manager: any = { isEffectivelyHidden: (uid: number) => uid === 99 };
const viewport = { uid: 1, type: 0, eventHandlers: { onScroll: { scriptId: 39 } } };
const scroll = (hits: any[]) => {
    invoked = [];
    const input = new InputManager();
    input.wheelDeltaY = 120;
    const frame: any = { input, mx: 20, my: 20, hits };
    processWidgetScrollWheelInput(deps, frame, manager, { isDraggingWidget: false } as any);
    grantedWheel = frame.input.viewportWheelDeltaY;
    return frame.input.wheelDeltaY;
};
const settings = { uid: 2, type: 0, isIf3: true, noScrollThrough: true, eventHandlers: { onScroll: { scriptId: 36 } } };
assert.equal(scroll([viewport, settings]), 0);
assert.deepEqual(invoked, [2], "foreground native scroll blocker runs its OWN scrollbar listener");
assert.equal(grantedWheel, 0, "list scrolling grants no HD camera wheel");
assert.equal(scroll([viewport, { uid: 3, type: 0, isIf3: true, noScrollThrough: true }]), 0, "blank blocker consumes camera wheel");
assert.deepEqual(invoked, [], "viewport zoom never runs behind settings");
assert.equal(scroll([viewport, { uid: 99, noScrollThrough: true }]), 0);
assert.deepEqual(invoked, [1], "hidden blocker does not steal scroll");
assert.equal(scroll([{ uid: 4, type: 0 }]), 120, "listener-only transparent layer preserves free camera wheel");
assert.equal(scroll([viewport]), 0); assert.deepEqual(invoked, [1], "native viewport zoom script still runs");
assert.equal(grantedWheel, 120, "viewport zoom grants the original wheel delta to HD");
assert.equal(scroll([viewport, { uid: 6, type: 3, transparency: 0 }]), 0);
assert.deepEqual(invoked, [], "a visible foreground surface blocks the viewport zoom listener");
assert.equal(grantedWheel, 0);
// A buff timer's text widget spans the whole screen but only draws "11m" in a corner.
const buffTimer = { uid: 7, type: 4, text: "11m", _textBounds: { x: 600, y: 10, width: 20, height: 12 } };
assert.equal(scroll([viewport, buffTimer]), 0);
assert.deepEqual(invoked, [1], "the empty part of a text widget's box does not block viewport zoom");
const overTimer = (hits: any[]) => {
    invoked = [];
    const input = new InputManager();
    input.wheelDeltaY = 120;
    processWidgetScrollWheelInput(deps, { input, mx: 605, my: 15, hits } as any, manager, { isDraggingWidget: false } as any);
};
overTimer([viewport, buffTimer]);
assert.deepEqual(invoked, [], "the drawn text itself still blocks viewport zoom");
assert.equal(scroll([viewport, { uid: 8, type: 4, text: "28m" }]), 0);
assert.deepEqual(invoked, [1], "text the renderer never drew does not block viewport zoom");
assert.equal(scroll([{ uid: 5, type: 0, isIf3: true, noScrollThrough: true, onScroll: [36, 10, 5] }]), 0);
assert.deepEqual(invoked, [5], "raw cache listener also runs on its owning blocker");

// A modal can open beneath a stationary pointer. Wheel must pick the current tree,
// rather than the cached viewport hit collected before Settings opened.
const modal = { ...settings, x: 0, y: 0, width: 200, height: 200, noClickThrough: true };
const pickingManager: any = { getInputRoots: () => [modal], getStaticChildrenByParentUid: () => [], interfaceParents: new Map(), getWidgetFlags: () => 0 };
const pickingState: any = { lastHoverHitX: 20, lastHoverHitY: 20, cachedHoverHits: [viewport] };
const picked = buildWidgetInputFrame({} as any, pickingState, { mouseX: 20, mouseY: 20, wheelDeltaY: 120 } as any, pickingManager, {} as any)!;
assert.ok(picked.hits.includes(modal), "wheel repicks a newly opened Settings modal at an unchanged pointer position");

const pinchInput = new InputManager();
pinchInput.pinchZoomDelta = 0.25;
const pinchPicked = buildWidgetInputFrame({} as any, pickingState, Object.assign(pinchInput, { mouseX: 20, mouseY: 20 }), pickingManager, {} as any)!;
assert.ok(pinchPicked.hits.includes(modal), "fractional pinch also repicks a newly opened modal");
invoked = [];
processWidgetScrollWheelInput(deps, { input: pinchInput, mx: 20, hits: [viewport, settings] } as any, manager, { isDraggingWidget: false } as any);
assert.equal(pinchInput.getCameraZoomDelta(), 0, "a Settings scroll owner consumes partial pinch before the viewport");
assert.equal(pinchInput.viewportWheelDeltaY, 0);
assert.deepEqual(invoked, [], "fractional pinch must not send a whole scroll step to Settings");

const input = new InputManager();
input.viewportWheelDeltaY = 120; input.wheelDeltaY = 120;
input.onFrameStart();
assert.equal(input.viewportWheelDeltaY, 0, "viewport grant is local to the current UI dispatch");
assert.equal(input.wheelDeltaY, 120, "incoming wheel survives frame start for UI ownership");
input.viewportWheelDeltaY = 120; input.onFrameEnd();
assert.equal(input.viewportWheelDeltaY, 0, "viewport grant cannot leak into a later frame");
input.element = { width: 800, height: 400, getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 200 }) } as any;
input.isPointerLock = () => false;
input.mouseX = 40; input.mouseY = 50;
input.setInteractionPointerOverride(40, 50, true);
(input as any).onWheel({ clientX: 210, clientY: 120, deltaY: 120, preventDefault() {} });
assert.deepEqual([input.mouseX, input.mouseY], [400, 200], "stationary wheel targets the physical cursor, not the close-camera keyboard selection");
input.isPointerLock = () => true;
input.mouseX = 40; input.mouseY = 50;
(input as any).onWheel({ clientX: 210, clientY: 120, deltaY: 120, preventDefault() {} });
assert.deepEqual([input.mouseX, input.mouseY], [40, 50], "captured mouse look keeps its world interaction pointer");

console.log("settings wheel ownership tests passed");
