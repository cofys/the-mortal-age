import assert from "node:assert/strict";
import { TRANSMIT_VARPS } from "../common/vars";
for (const id of [2357, 2358, 2359, 2370])
    assert.ok(TRANSMIT_VARPS.has(id), "Adventure Path view varp " + id);
for (const id of [2361, 2362, 2363, 2364, 2365, 2366, 2367, 2368, 2371])
    assert.equal(TRANSMIT_VARPS.has(id), false, "server-owned progress " + id);
console.log("Adventure Paths client transmit whitelist: ok");

// Exercise server-invoked catalogues; these have no static interface onLoad listener.
import { createCacheVm } from "../scripts/cache/cs2-sweep";
import { createScriptEvent, ExecutionState } from "../rs/cs2/Cs2Vm";
const { vm } = createCacheVm();
const errors: string[] = [];
vm.logError = (error: any) => errors.push(String(error?.message ?? error));
vm.context.widgetManager.rootInterface = 161;
for (const group of [161, 643]) vm.context.widgetManager.getGroup(group);
for (const args of [
    [2843, 689],
    [2843, 1264],
    [3509, 0, "Combat path voucher"],
]) {
    vm.executionState = ExecutionState.FINISHED;
    vm.intStackSize = vm.stringStackSize = vm.longStackSize = 0;
    vm.runScriptEvent(createScriptEvent({ args }), 200000);
}
assert.deepEqual(errors, []);
console.log("Adventure Paths native path/voucher reward renderers: ok");
