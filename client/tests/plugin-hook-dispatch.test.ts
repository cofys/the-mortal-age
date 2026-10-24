import assert from "node:assert/strict";

import { ClientPluginManager } from "../game/plugins/ClientPluginManager";

const hooks = [
    "configureSceneDrawCall", "onScriptFinished", "getPlayerHeadIcons",
    "widgetOverlay", "placeOverlay", "updateWidgetLayout",
];
const manager = new ClientPluginManager();
let absentChecks = 0;
for (let i = 0; i < 40; i++) manager.add(new Proxy({}, {
    get(target, key) {
        if (hooks.includes(key as string)) absentChecks++;
        return Reflect.get(target, key);
    },
}));
const calls: string[] = [];
let enabled = true;
const icon = {} as any;
const overlay = { signature: () => "", draw: () => [] };
const provider = {
    name: "first",
    configureSceneDrawCall() { if (enabled) calls.push(`${this.name}:draw`); },
    onScriptFinished(script: number) { if (enabled) calls.push(`${this.name}:script:${script}`); },
    getPlayerHeadIcons() { return enabled ? [icon] : []; },
    widgetOverlay: overlay,
    placeOverlay() { return enabled ? { x: 1, y: 2, scaleX: 1, scaleY: 1 } : undefined; },
    updateWidgetLayout() { if (enabled) calls.push(`${this.name}:layout`); },
};
manager.add(provider);
const run = [
    () => manager.configureSceneDrawCall({} as any, {} as any),
    () => manager.onScriptFinished(123),
    () => manager.playerHeadIcons(1),
    () => manager.widgetOverlays(),
    () => manager.placeOverlay(overlay, 100, 100, { w: 800, h: 600 }),
    () => manager.updateWidgetLayout(),
];
const checks: number[] = [];
for (const hook of run) {
    hook(); // Warm only this hook's implementer list.
    absentChecks = 0;
    for (let i = 0; i < 100; i++) hook();
    checks.push(absentChecks);
}
assert.deepEqual(checks, [0, 0, 0, 0, 0, 0], "warm hot hooks must not inspect the 40 unrelated plugins");
assert.deepEqual(manager.playerHeadIcons(1), [icon]);
assert.deepEqual(manager.widgetOverlays(), [overlay]);
assert.deepEqual(manager.placeOverlay(overlay, 10, 10, { w: 800, h: 600 }),
    { x: 1, y: 2, scaleX: 1, scaleY: 1 });

// Enabled state stays in the live plugin hook; only membership is cached.
enabled = false;
calls.length = 0;
for (const hook of run) hook();
assert.deepEqual(calls, []);
assert.deepEqual(manager.playerHeadIcons(1), []);
assert.equal(manager.placeOverlay(overlay, 10, 10, { w: 800, h: 600 }), undefined);
enabled = true;

// Late plugins invalidate warm lists. Preserve receivers, order, and first-provider placement.
const second = { ...provider, name: "second" };
manager.add(second);
calls.length = 0;
manager.configureSceneDrawCall({} as any, {} as any);
manager.onScriptFinished(456);
manager.updateWidgetLayout();
assert.deepEqual(calls, ["first:draw", "second:draw", "first:script:456", "second:script:456", "first:layout", "second:layout"]);
assert.deepEqual(manager.playerHeadIcons(1), [icon, icon]);
assert.deepEqual(manager.widgetOverlays(), [overlay, overlay]);
second.placeOverlay = () => { throw new Error("only the first placement provider should be called"); };
assert.deepEqual(manager.placeOverlay(overlay, 10, 10, { w: 800, h: 600 }),
    { x: 1, y: 2, scaleX: 1, scaleY: 1 });

console.log("Plugin hook checks: 24,000 absent-hook inspections before; 0 after (600 dispatches).");
