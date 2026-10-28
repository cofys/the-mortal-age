import assert from "node:assert/strict";
import { GameState } from "../runelite/api/GameState";
import { GameStateChanged, PluginMessage } from "../runelite/api/events";
import { ConfigManager } from "../runelite/client/config/ConfigManager";
import { CLIENT_TOKEN, PluginInjector } from "../runelite/client/plugins/PluginInjector";
import { PestControlPlugin } from "../game/plugins/pestcontrol/PestControlPlugin";
import { createScriptEvent } from "../rs/cs2/Cs2Vm";
import { createCacheVm } from "../scripts/cache/cs2-sweep";

const { vm } = createCacheVm();
const manager = vm.context.widgetManager;
const plugin = new PluginInjector(new ConfigManager(undefined))
    .provide(CLIENT_TOKEN, { widgetManager: manager })
    .runWith(() => new PestControlPlugin());
vm.context.getStatBase = () => 65;
vm.context.varManager.setVarp(261, 1000);
vm.context.onScriptFinished = (id: number) => plugin.onScriptFinished(id);
manager.onLoadListener = (_id: number, widget: any) => vm.runScriptEvent(createScriptEvent({ args: widget.onLoad, widget }), 200_000);
manager.onLoadInvoker = (widget: any) => vm.invokeEventHandler(widget, "onLoad");
manager.getGroup(243);
const root = manager.getWidgetByUid(243 << 16);
const redraw = () => manager.triggerOnLoad(root);
const rows = () => manager.getDynamicChildrenByParent((243 << 16) | 3).map((widget: any) => widget.text).filter(Boolean);

redraw();
assert.ok(rows().includes("Attack - 245 XP"));
plugin.onPluginMessage(new PluginMessage("pest-control", { xpPerPoint: { Attack: 24_500, Prayer: 12_600 } }));
assert.ok(rows().includes("Attack - 24500 XP"));
assert.ok(rows().includes("Prayer - 12600 XP"));
redraw();
assert.ok(rows().includes("Attack - 24500 XP"), "cache redraws must keep the scaled reward");
plugin.onPluginMessage(new PluginMessage("pest-control", { xpPerPoint: { Attack: 367.5 } }));
assert.ok(rows().includes("Attack - 367.5 XP"), "fractional server rates keep their tenths");
plugin.onPluginMessage(new PluginMessage("pest-control", { xpPerPoint: { Attack: Infinity } }));
redraw();
assert.ok(rows().includes("Attack - 245 XP"), "invalid values cannot reach the widget text");
plugin.onPluginMessage(new PluginMessage("pest-control", { xpPerPoint: { Attack: 24_500 } }));
plugin.onGameStateChanged(new GameStateChanged(GameState.HOPPING));
redraw();
assert.ok(rows().includes("Attack - 245 XP"), "a new world cannot inherit the old world's rewards");
console.log("Pest Control reward labels follow server XP rates through cache redraws");
