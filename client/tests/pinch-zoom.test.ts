import assert from "node:assert/strict";

import { InputManager } from "../game/InputManager";
import { processWidgetScrollWheelInput } from "../game/widgets/input/widgetScrollWheelInput";
import { processWidgetMinimapWheelInput } from "../game/widgets/input/widgetMinimapWheelInput";
import { processWidgetMenuWheelInput } from "../game/widgets/input/widgetMenuWheelInput";
import { SCROLL_WHEEL_ZOOM_INCREMENT_EVENT } from "../rs/cs2/zoomCallbacks";
import { Cs2Vm } from "../rs/cs2/Cs2Vm";

const fovVm = new Cs2Vm({ getViewportFovValues: () => ({ low: 250, high: 314 }) } as any);
const cachedContext = (fovVm as any).createHandlerContext();
assert.deepEqual(cachedContext.getViewportFovValues(), { low: 250, high: 314 });
fovVm.context.getViewportFovValues = () => ({ low: 256, high: 320 });
assert.deepEqual(cachedContext.getViewportFovValues(), { low: 256, high: 320 },
    "the cached opcode context must see the scoped precise pinch readback");

function fixture(increment = 25) {
    const input: any = new InputManager();
    input.element = { width: 800, height: 400,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) };
    let distance = 100, zoom = 0, uiCalls = 0, minimapCalls = 0, blocked = false, readbackLoss = 0;
    const event = () => ({ touches: [{ clientX: 100, clientY: 100 },
        { clientX: 100 + distance, clientY: 100 }], preventDefault() {} });
    const camera = { uid: 1, type: 0, eventHandlers: { onScroll: { scriptId: 39 } } };
    const frame: any = { input, mx: 150, my: 100, hits: [camera] };
    const manager: any = { isEffectivelyHidden: () => false };
    const interaction: any = { isDraggingWidget: false, isPointerOverMinimapClickTarget: () => true };
    const plugin = (_script: unknown, name: string) => {
        if (name === SCROLL_WHEEL_ZOOM_INCREMENT_EVENT) vm.intStack[0] = increment;
    };
    const vm: any = {
        intStack: [25], intStackSize: 1, scriptCallbackListeners: new Set([plugin]),
        context: { getViewportFovValues: () => ({ low: 256 + zoom - readbackLoss, high: 320 + zoom - readbackLoss }) },
        invokeEventHandler(w: any, _name: string, context: any) {
            if (w !== camera) { uiCalls++; return; }
            if (blocked) return; // Control-to-zoom returns before its increment callback.
            vm.intStack[0] = 25;
            for (const callback of vm.scriptCallbackListeners) callback({}, SCROLL_WHEEL_ZOOM_INCREMENT_EVENT);
            zoom = vm.context.getViewportFovValues().low - 256 + context.mouseY * vm.intStack[0];
        },
    };
    const deps: any = { getCs2Vm: () => vm, getMinimapZoomEnabled: () => true,
        getMenuOpen: () => false, getRenderer: () => ({}),
        getVarManager: () => ({ getVarcInt: (id: number) => (id === 73 ? 256 : 320) + zoom }),
        applyMinimapWheelZoom: () => minimapCalls++ };
    input.onTouchStart(event());
    return {
        input, frame, manager, interaction, vm, deps, camera,
        move(delta: number) { distance += delta; input.onTouchMove(event()); },
        scroll() { processWidgetScrollWheelInput(deps, frame, manager, interaction); },
        get zoom() { return zoom; }, get uiCalls() { return uiCalls; }, get minimapCalls() { return minimapCalls; },
        block(value: boolean) { blocked = value; },
        setReadbackLoss(value: number) { readbackLoss = value; },
    };
}

const small = fixture();
small.move(1);
assert.equal(small.input.wheelDeltaY, 0, "widgets still wait for a complete pinch notch");
small.scroll();
assert.equal(small.zoom, -1, "the camera must respond before 20 px of finger travel");
assert.equal(small.input.viewportWheelDeltaY, -5, "HD receives the continuous accepted delta before gesture clearing");
assert.equal(small.vm.scriptCallbackListeners.size, 1, "the temporary scaler leaves the plugin listener intact");
small.input.onFrameEnd();
small.move(1);
small.scroll();
assert.equal(small.zoom, -2);

function travel(moves: number[], step = 25): number {
    const f = fixture(step);
    for (const delta of moves) { f.move(delta); f.scroll(); f.input.onFrameEnd(); }
    return f.zoom;
}
assert.equal(travel(Array(40).fill(1)), -50, "keep the previous 25 camera units per 20 px sensitivity");
assert.equal(travel([40]), -50, "event coalescing must not discard pinch distance");
assert.equal(travel(Array(80).fill(0.5)), -50, "subpixel travel carries fractional camera units between frames");
assert.equal(travel([1, -0.5, -0.5]), 0, "reversing direction cancels fractional travel");
assert.equal(travel(Array(20).fill(1), 50), -50, "the configured Camera plugin step still scales the gesture");
assert.equal(travel(Array(20).fill(1), -25), 25, "a callback that inverts zoom keeps its direction");
const rounded = fixture();
rounded.setReadbackLoss(2);
const nativeFovGetter = rounded.vm.context.getViewportFovValues;
for (let i = 0; i < 40; i++) { rounded.move(1); rounded.scroll(); rounded.input.onFrameEnd(); }
assert.equal(rounded.zoom, -50, "native FOV round-trip rounding must not stall or reverse tiny pinch steps");
assert.equal(rounded.vm.context.getViewportFovValues, nativeFovGetter, "native FOV reads remain unchanged outside pinch dispatch");

const ordinary = fixture();
ordinary.input.wheelDeltaY = 100;
ordinary.scroll();
assert.equal(ordinary.zoom, 25, "mouse wheels keep their native step");
const mixed = fixture();
mixed.move(1);
mixed.input.wheelDeltaY += 100;
assert.equal(mixed.input.getCameraZoomDelta(), 95, "physical wheel input is retained beside continuous pinch input");
mixed.scroll();
assert.equal(mixed.zoom, 23);
const crossing = fixture();
crossing.move(19); crossing.scroll(); crossing.input.onFrameEnd();
crossing.move(1); crossing.move(-1); crossing.scroll();
assert.equal(crossing.zoom, -23, "crossing a notch and reversing in one frame must not add a notch");

const ui = fixture();
ui.frame.hits = [{ uid: 2, type: 0, eventHandlers: { onScroll: { scriptId: 123 } } }];
for (let i = 0; i < 20; i++) { ui.move(1); ui.scroll(); ui.input.onFrameEnd(); }
assert.equal(ui.uiCalls, 1, "other widget scroll listeners retain whole-notch delivery");
const minimap = fixture();
for (let i = 0; i < 20; i++) {
    minimap.move(1);
    processWidgetMinimapWheelInput(minimap.deps, minimap.frame, minimap.manager, minimap.interaction);
    minimap.scroll(); minimap.input.onFrameEnd();
}
assert.equal(minimap.minimapCalls, 1);
assert.equal(minimap.zoom, 0, "minimap pinches must not reach the camera");
const covered = fixture();
covered.frame.hits.push({ uid: 2, type: 3 });
covered.move(1); covered.scroll();
assert.equal(covered.zoom, 0, "a visible widget above the scene still blocks camera zoom");
assert.equal(covered.input.getCameraZoomDelta(), 0);
const menu = fixture();
const menuRuntime = { menuScrollMax: 10, menuScroll: 3, closeMargin: 0,
    mainRect: { x: 0, y: 0, w: 800, h: 400 } };
menu.deps.getRenderer = () => ({ canvas: { __ui: { menu: { open: true }, __menuRt: menuRuntime } } });
menu.move(1);
processWidgetMenuWheelInput(menu.deps, menu.frame);
menu.scroll();
assert.equal(menuRuntime.menuScroll, 3, "a partial pinch must not scroll the menu a full row");
assert.equal(menu.zoom, 0);

const controlled = fixture();
controlled.block(true); controlled.move(5); controlled.scroll();
assert.equal(controlled.zoom, 0, "Control-to-zoom can still suppress the native script");
assert.equal(controlled.vm.scriptCallbackListeners.size, 1);
const throwing = fixture();
const throwingFovGetter = throwing.vm.context.getViewportFovValues;
throwing.vm.invokeEventHandler = () => { throw Error("script failure"); };
throwing.move(1);
assert.throws(() => throwing.scroll(), /script failure/);
assert.equal(throwing.vm.scriptCallbackListeners.size, 1, "script failures must remove the temporary scaler");
assert.equal(throwing.vm.context.getViewportFovValues, throwingFovGetter, "script failures also restore the native FOV getter");

console.log("Continuous camera pinch, native/plugin steps and widget routing passed");
