import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createCacheVm } from "../scripts/cache/cs2-sweep";
import { Inventory } from "../rs/inventory/Inventory";
import { WidgetTransmitProcessor } from "../game/widgets/WidgetTransmitProcessor";
import { getTransmitCycles, resetTransmitCycles, markWidgetsLoaded, markInvTransmit } from "../game/TransmitCycles";
import { handleInboundUi } from "../network/serverConnection/handlers/inboundUi";
import { deriveRawMenuEntriesForWidget } from "../widgets/menu/utils";

test("warm actual inventory CS2 names and operations follow archive install/removal without item mutation", () => {
    resetTransmitCycles();
    const { vm } = createCacheVm();
    const wm = vm.context.widgetManager;
    wm.rootInterface = 149;
    wm.getGroup(149);
    const parent = wm.getWidgetByUid(149 << 16);
    const inventory = new Inventory(28);
    inventory.setSlot(2, 32926, 1);
    vm.context.inventories = new Map([[93, inventory]]);
    vm.run(vm.context.loadScript(6007), [149 << 16, 1], []);
    assert.equal(vm.lastError, null);
    const queue: any[] = [];
    let queued = 0;
    const processor = new WidgetTransmitProcessor({getWidgetManager: () => wm,
        getCs2Vm: () => vm, getTransmitCycles,
        queueScriptEvent: event => { queued++; queue.push(event); },
        executeScriptListener: (widget, args) => vm.runScriptEvent({widget, args})});
    const flush = () => { processor.processWidgetTransmits(); while(queue.length) vm.runScriptEvent(queue.shift());
        assert.equal(vm.lastError, null, "actual cache inventory handler executes"); };
    const options = () => deriveRawMenuEntriesForWidget(parent.children[2]).map(entry => entry.option);
    const oldName = parent.children[2].opBase;
    const oldOptions = options();
    assert.ok(!oldOptions.includes("Inspect"));
    const oldClient = (globalThis as any).__osrsClient;
    (globalThis as any).__osrsClient = {objTypeLoader: vm.context.objTypeLoader};
    const bundle = JSON.parse(readFileSync(resolve(__dirname,
        "../../server/plugins/world/seasonal/data/christmas-2025-archive.json"), "utf8")).bundle;
    const content = (rows: any[]) => handleInboundUi({type:"gamemode_data",
        payload:{gamemodeId:"world", datasets:[{key:"definitionArchives", rows}]}});
    try {
        markWidgetsLoaded(); flush();
        const invCount = getTransmitCycles().changedInvCount;
        content([bundle]); flush();
        assert.match(parent.children[2].opBase, /Serving platter/);
        assert.ok(options().includes("Inspect"), "real inventory_drawitem must rebuild the native operation");
        assert.equal(getTransmitCycles().changedInvCount, invCount, "definition refresh is not an inventory mutation");
        assert.equal(inventory.getSlot(2)?.itemId, 32926);
        assert.equal(inventory.getSlot(2)?.quantity, 1);
        const afterRefresh = queued;
        content([bundle]); flush();
        markWidgetsLoaded(); flush();
        assert.equal(queued, afterRefresh, "identical archive and unchanged visible widgets do not rebuild again");
        markInvTransmit(95); flush();
        assert.equal(queued, afterRefresh, "ordinary unrelated inventory changes still respect inv93 triggers");
        parent.hidden = parent.isHidden = true;
        content([]); flush();
        assert.match(parent.children[2].opBase, /Serving platter/, "hidden widgets defer work");
        parent.hidden = parent.isHidden = false;
        markWidgetsLoaded(); flush(); // CC/IF_SETHIDE and subinterface-open notify this same owner.
        assert.equal(parent.children[2].opBase, oldName);
        assert.deepEqual(options(), oldOptions);
        assert.equal(getTransmitCycles().changedInvCount, invCount + 1);
    } finally {
        content([]);
        if (oldClient === undefined) delete (globalThis as any).__osrsClient;
        else (globalThis as any).__osrsClient = oldClient;
    }
});
