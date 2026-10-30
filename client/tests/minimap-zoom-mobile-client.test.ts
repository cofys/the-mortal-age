import assert from "node:assert/strict";
import { test } from "node:test";

import { createCacheVm } from "../scripts/cache/cs2-sweep";

// #1510: the cache makes the minimap zoomable (minimap_setzoomable, here through script 5191)
// only for the current client, which script 100 checks with the clienttype opcode. Mobile used
// to report 2, the pre-2024 android client, so pinching the minimap did nothing.
const CURRENT_CLIENT = 100, SET_ZOOMABLE = 5191;

function zoomableOn(rootInterface: number) {
    const { vm } = createCacheVm();
    vm.context.widgetManager.rootInterface = rootInterface;
    const calls: boolean[] = [];
    vm.context.setMinimapZoomable = (enabled: boolean) => calls.push(enabled);
    vm.run(vm.context.loadScript(SET_ZOOMABLE), [1], []);
    vm.run(vm.context.loadScript(CURRENT_CLIENT), [], []);
    return { calls, current: vm.intStack[vm.intStackSize - 1] };
}

test("the mobile layout is the current client, so its minimap can zoom", () => {
    const mobile = zoomableOn(601);
    assert.equal(mobile.current, 1, "script 100 accepts the mobile client type");
    assert.deepEqual(mobile.calls, [true]);
});

test("the desktop layout keeps its minimap zoom", () => {
    assert.deepEqual(zoomableOn(161).calls, [true]);
});
