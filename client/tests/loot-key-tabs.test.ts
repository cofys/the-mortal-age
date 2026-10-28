import assert from "node:assert/strict";

import { createCacheVm } from "../scripts/cache/cs2-sweep";
import { Inventory } from "../rs/inventory/Inventory";

// Rev 241: 8006 builds five 742:4 tabs; 8017 changes varbit 4842 locally.
// The server also needs an op flag to receive that choice and open the next key.
const { vm } = createCacheVm();
const manager = vm.context.widgetManager;
const inventory = new Inventory(28);
inventory.setSlot(0, 26652, 1);
vm.context.inventories = new Map([[93, inventory], ...[558, 559, 560, 561, 562].map((id) => [id, new Inventory(28)] as const)]);
vm.context.varManager.setVarbit(4842, 0);
manager.getGroup(742);
vm.run(vm.context.loadScript(8006), [], []);
const tabsUid = (742 << 16) | 4;
for (let slot = 0; slot < 5; slot++) manager.setWidgetFlagsByKey(tabsUid, slot, 2);
const tabs = manager.getDynamicChildrenByParent(tabsUid);
const next = tabs.find((tab: any) => tab.childIndex === 1);
assert.ok(next);
assert.equal(next.actions[0], "View tab");
assert.equal(manager.getWidgetFlags(next) & 2, 2, "the tab must transmit op 1");
vm.invokeEventHandler(next, "onOp", { opIndex: 1 });
assert.equal(vm.context.varManager.getVarbit(4842), 1);

// A reply restores tab 0 while its loot is unclaimed, then opens tab 1 when it is empty.
vm.context.varManager.setVarbit(4842, 0);
vm.run(vm.context.loadScript(8006), [], []);
assert.equal(vm.context.varManager.getVarbit(4842), 0);
inventory.setSlot(0, -1, 0);
vm.context.inventories.get(559).setSlot(0, 554, 7);
vm.context.varManager.setVarbit(4842, 1);
vm.run(vm.context.loadScript(8006), [], []);
const item = manager.getDynamicChildrenByParent((742 << 16) | 5).find((child: any) => child.childIndex === 28);
assert.equal(item.itemId, 554);
assert.equal(item.itemQuantity, 7);
assert.equal(item.isHidden, false);
console.log("loot key cache tab selection passed");
