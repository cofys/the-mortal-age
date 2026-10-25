import { strict as assert } from "node:assert";
import { MenuManager } from "@runelite/client/menus/MenuManager";
import { WidgetMenuOption } from "@runelite/client/menus/WidgetMenuOption";
import { ClientState } from "../game/ClientState";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";
import { applyMenuTransform, setManagedMenus } from "../ui/menu/menuTransforms";

const ORB = (160 << 16) | 55;
const ORB_NOMAP = (895 << 16) | 53;
const OTHER = (160 << 16) | 20;
const context = (widgetId: number) => ({ surface: "widget" as const, menu: true, widgetId, childIndex: -1, itemId: -1 });
// A widget's menu in display order: its ops (op 1 on top), then Cancel.
const orbMenu = (): SimpleMenuEntry[] => [
    { option: "Floating World Map", target: "", opcode: 57 },
    { option: "Fullscreen World Map", target: "", opcode: 57 },
    { option: "Cancel", target: "" },
];

const menus = new MenuManager();
const clicked: string[] = [];
const exportOption = new WidgetMenuOption("Export", "Ground Markers", ORB, ORB_NOMAP);
const importOption = new WidgetMenuOption("Import", "Ground Markers", ORB, ORB_NOMAP);
const clearOption = new WidgetMenuOption("Clear", "Ground Markers", ORB, ORB_NOMAP);
assert.equal(exportOption.menuTarget, "<col=ff9040>Ground Markers</col>", "the target in JagexColors.MENU_TARGET");
menus.addManagedCustomMenu(exportOption, () => clicked.push("export"));
menus.addManagedCustomMenu(importOption, () => clicked.push("import"));
menus.addManagedCustomMenu(clearOption, () => clicked.push("clear"));

// RuneLite adds them as the widget's first CC_OP entry is added (its lowest), just above it.
let menu = menus.apply(orbMenu(), context(ORB));
assert.deepEqual(menu.map((e) => e.option), ["Floating World Map", "Export", "Import", "Clear", "Fullscreen World Map", "Cancel"]);
assert.equal(menu[1].target, "<col=ff9040>Ground Markers</col>");
assert.equal(menu[1].param1, ORB);
menu[2].onClick?.();
assert.deepEqual(clicked, ["import"]);
assert.deepEqual(menus.apply(menu, context(ORB)), menu, "once: not added again");
assert.equal(menus.apply(orbMenu(), context(ORB_NOMAP)).length, 6, "the no-map orb too");
assert.equal(menus.apply(orbMenu(), context(OTHER)).length, 3, "other widgets untouched");
assert.equal(menus.apply([{ option: "Cancel", target: "" }], context(ORB)).length, 1, "no CC_OP entry, nothing added");

ClientState.isSpellSelected = true;
assert.equal(menus.apply(orbMenu(), context(ORB)).length, 3, "not while a spell is selected");
ClientState.isSpellSelected = false;
ClientState.isItemSelected = 1;
assert.equal(menus.apply(orbMenu(), context(ORB)).length, 3, "not while an item is selected");
ClientState.isItemSelected = 0;

// Through the menu pipeline: added before plugins (whose transform does not reach this widget).
setManagedMenus((entries, ctx) => menus.apply(entries, ctx));
menu = applyMenuTransform(orbMenu(), context(ORB));
assert.deepEqual(menu.map((e) => e.option), ["Floating World Map", "Export", "Import", "Clear", "Fullscreen World Map", "Cancel"]);
assert.equal(applyMenuTransform(orbMenu(), { surface: "world", menu: true }).length, 3, "world menus untouched");

menus.removeManagedCustomMenu(importOption);
assert.deepEqual(menus.apply(orbMenu(), context(ORB)).map((e) => e.option),
    ["Floating World Map", "Export", "Clear", "Fullscreen World Map", "Cancel"], "removed");
menus.removeManagedCustomMenu(exportOption);
menus.removeManagedCustomMenu(clearOption);
assert.equal(menus.apply(orbMenu(), context(ORB)).length, 3);
setManagedMenus(undefined);

console.log("menu-manager tests passed");
