import assert from "node:assert/strict";

import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { getVariations, mapVariation } from "@runelite/client/game/ItemVariationMapping";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { sha256Hex } from "../common/utils/sha256";
import type { BankTagsClient } from "../game/plugins/banktags/bankClient";
import { Bankmain } from "../game/plugins/banktags/bankmain";
import { BankTagsPlugin } from "../game/plugins/banktags/BankTagsPlugin";
import { Layout } from "../game/plugins/banktags/tabs/Layout";
import { TabManager } from "../game/plugins/banktags/tabs/TabManager";
import { TagManager } from "../game/plugins/banktags/TagManager";
import { createScriptEvent, ExecutionState } from "../rs/cs2/Cs2Vm";
import { assembleRs2asm } from "../rs/cs2/rs2asm";
import { RUNELITE_BANK_SCRIPTS } from "../rs/cs2/runelite/bankScripts";
import { Opcodes } from "../rs/cs2/Opcodes";
import { Inventory } from "../rs/inventory/Inventory";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";
import { createCacheVm } from "../scripts/cache/cs2-sweep";

const config = inject(ConfigManager);
const clearConfig = () => {
    for (const key of config.getConfigurationKeys("banktags.")) config.unsetConfiguration("banktags", key.slice("banktags.".length));
};
clearConfig();

// --- SHA-256 and the assembler ---------------------------------------------------------------

assert.equal(sha256Hex(new Uint8Array(0)), "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855");
assert.equal(sha256Hex(new TextEncoder().encode("abc")), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD");

const tiny = assembleRs2asm(`.id 9000
.int_arg_count 1
.obj_arg_count 0
   iload 0 ; the arg
   iconst 2
   if_icmpgt BIG
   sconst "small; still a string"
   return
BIG:
   istore 3
   return`);
assert.equal(tiny.id, 9000);
assert.deepEqual([...tiny.instructions], [Opcodes.ILOAD, Opcodes.ICONST, Opcodes.IF_ICMPGT, Opcodes.SCONST, Opcodes.RETURN, Opcodes.ISTORE, Opcodes.RETURN]);
assert.equal(tiny.intOperands[2], 2, "a jump's offset is target - pc - 1");
assert.equal(tiny.stringOperands[3], "small; still a string", "a ; inside a string isn't a comment");
assert.equal(tiny.localIntCount, 4, "locals: the highest index used, plus one");

// --- The cache's bank scripts are RuneLite's, so RuneLite's patches replace them ----------------

const { vm, scripts, cache } = createCacheVm();
for (const patch of RUNELITE_BANK_SCRIPTS) {
    const script = scripts.load(patch.id)!;
    assert.ok(script.stringOperands.includes(patch.id === 279 ? "bankSearchFilter" : patch.id === 276 ? "getSearchingTagTab" : "setSearchBankInputText"),
        `script ${patch.id} is RuneLite's ${patch.name}`);
}
void cache;

// --- Item variations ---------------------------------------------------------------------------

assert.equal(mapVariation(4151), 4151, "an abyssal whip is its own base");
const dragonScimitar = getVariations(mapVariation(20000));
assert.ok(dragonScimitar.length >= 1);

// --- TagManager and TabManager -----------------------------------------------------------------

const noted = (id: number) => (id === 4152 ? 4151 : id); // a noted whip is the whip
const tags = new TagManager(config, noted);
tags.addTag(4152, "Melee", false);
assert.equal(config.getConfiguration("banktags", "item_4151"), "melee", "stored under the canonical item, standardized");
tags.addTag(4151, "slayer", false);
assert.deepEqual([...tags.getTags(4151, false)], ["melee", "slayer"]);
assert.ok(tags.findTag(4151, "sla"), "a search matches a tag's start");
assert.ok(!tags.findTag(4151, "ayer"));
tags.addTag(4151, "whips", true);
assert.equal(config.getConfiguration("banktags", `item_-${mapVariation(4151)}`), "whips", "a variation tag is under the negated base id");
// As in RuneLite: the variation key's id reads the item's own tags as well.
assert.deepEqual(tags.getItemsForTag("melee"), [4151, -4151]);
tags.renameTag("slayer", "task");
assert.deepEqual([...tags.getTags(4151, false)], ["melee", "task"]);
tags.removeTag("task");
assert.deepEqual([...tags.getTags(4151, false)], ["melee"]);
tags.setHidden("melee", true);
assert.ok(tags.isHidden("Melee"));
tags.setHidden("melee", false);
clearConfig();

const tabs = new TabManager(config);
for (const name of ["a", "b", "c"]) tabs.add(tabs.load(name));
assert.equal(tabs.find("A")?.iconItemId, 952, "a new tab's icon is a spade");
tabs.insert("c", "a");
assert.deepEqual(tabs.tabs.map((t) => t.tag), ["c", "a", "b"], "insert: moved before the destination");
tabs.swap("c", "b");
assert.deepEqual(tabs.tabs.map((t) => t.tag), ["b", "a", "c"]);
tabs.save();
assert.equal(config.getConfiguration("banktags", "tagtabs"), "b,a,c");
assert.equal(config.getConfiguration("banktags", "icon_a"), "952");
clearConfig();

// --- Layout ------------------------------------------------------------------------------------

const l = new Layout("t", [1, 2, -1, 3]);
l.insert(0, 3);
assert.deepEqual(l.getLayout(), [-1, 2, 3, 1], "insert towards the end shifts down to the blank slot");
l.insert(3, 0);
assert.deepEqual(l.getLayout(), [1, 2, 3, -1]);
l.addItemAfter(9, 1);
assert.deepEqual(l.getLayout(), [1, 2, 3, 9]);
l.addItemAfter(8, 2);
assert.deepEqual(l.getLayout(), [1, 2, 3, 9, 8], "no blank slot: the layout grows");
assert.equal(l.lastItemIndex(), 4);

// --- The plugin against the real bank interface -------------------------------------------------

const manager = vm.context.widgetManager;
const bank = new Inventory(1410);
const WHIP = 4151, PLATEBODY = 1127, PLATELEGS = 1079, SHARK = 385, COINS = 995;
[COINS, WHIP, PLATEBODY, PLATELEGS, SHARK].forEach((id, slot) => bank.setSlot(slot, id, id === COINS ? 1000 : 1));
const inventory = new Inventory(28);
inventory.setSlot(0, SHARK, 1);
vm.context.inventories = new Map([[95, bank], [93, inventory], [94, new Inventory(14)]]);
manager.rootInterface = 161;
manager.onLoadListener = (_id: number, widget: any) => vm.runScriptEvent(createScriptEvent({ args: widget.onLoad, widget }), 2000000);
manager.onLoadInvoker = (widget: any) => vm.invokeEventHandler(widget, "onLoad");

const objs = vm.context.objTypeLoader;
const messages: string[] = [];
const client: BankTagsClient = {
    widgets: manager,
    vm,
    getWidget: (id) => manager.getWidgetByUid(id),
    getItemDefinition: (id) => objs.load(id),
    canonicalize: (id) => id,
    getItemCount: () => objs.getCount(),
    getItemContainer: (id) => vm.context.inventories.get(id),
    getVarbitValue: (id) => vm.context.varManager.getVarbit(id),
    setVarbit: (id, v) => vm.context.varManager.setVarbit(id, v),
    getVarpValue: (id) => vm.context.varManager.getVarp(id),
    getVarcStrValue: (id) => String(vm.context.varManager.getVarcString(id) ?? ""),
    setVarcIntValue: (id, v) => vm.context.varManager.setVarcInt(id, v),
    setVarcStrValue: (id, v) => vm.context.varManager.setVarcString(id, v),
    getEnumIntValue: () => -1,
    runScript: (id, ...args) => {
        assert.notEqual(vm.executionState, ExecutionState.RUNNING, "never from inside a script");
        vm.run(vm.context.loadScript(id), args.filter((a): a is number => typeof a === "number"), []);
    },
    runListener: (widget, event) => vm.invokeEventHandler(widget, event),
    isShiftPressed: () => false,
    playSoundEffect: () => {},
    sendChatMessage: (m) => messages.push(m),
    getDraggedWidget: () => undefined,
    getDraggedOnWidget: () => undefined,
    setDraggedOnWidget: () => {},
};
const prompts: { title: string; onDone?: (v: string) => void }[] = [];
const chatbox: any = {
    openTextInput(title: string) {
        const p: (typeof prompts)[number] = { title };
        const b: any = { addCharValidator: () => b, value: () => b, onDone: (f: any) => ((p.onDone = f), b), build: () => (prompts.push(p), b) };
        return b;
    },
    openTextMenuInput: () => {
        const b: any = { option: () => b, onClose: () => b, build: () => b };
        return b;
    },
    getCurrentInput: () => undefined,
    close: () => {},
};

const plugin = new BankTagsPlugin(undefined, { client, configManager: config, chatboxPanelManager: chatbox });
vm.scriptCallbackListeners.add((_s: unknown, eventName: string) => plugin.onScriptCallback({ eventName, vm }));
vm.scriptPostListeners.add((id: number) => plugin.onScriptFinished(id));

async function main(): Promise<void> {
    await plugin.start();
    for (const root of manager.getAllGroupRoots(12)) manager.triggerOnLoad(root);
    const items = manager.getWidgetByUid(Bankmain.ITEMS)!;
    const build = () => vm.invokeEventHandler(items, "onInvTransmit");
    build();
    const shown = () =>
        (items.children ?? [])
            .filter((c: any) => c && !c.hidden && c.itemId > 0 && c.itemId !== 6512)
            .map((c: any) => [c.childIndex, c.itemId, c.rawX, c.rawY]);
    assert.deepEqual(shown().map(([, id]) => id), [COINS, WHIP, PLATEBODY, PLATELEGS, SHARK], "untagged: the whole bank");

    // The tab layer: scroll, up, down and new-tab buttons in the item container.
    const container = manager.getWidgetByUid(Bankmain.ITEMS_CONTAINER)!;
    assert.equal(container.children!.length, 4);
    assert.equal(container.children![3].spriteId, -205, "the new-tab button is RuneLite's sprite");

    // Edit-tags just above Examine, then tagging two items.
    const bankItemMenu = (slot: number) =>
        plugin.transformMenuEntries(
            [{ option: "Withdraw-1", target: "x" }, { option: "Examine", target: "x" }, { option: "Cancel", target: "" }] as SimpleMenuEntry[],
            { surface: "widget", menu: true, widgetId: items.children![slot]!.uid, childIndex: slot, itemId: items.children![slot]!.itemId },
        );
    let menu = bankItemMenu(1);
    assert.deepEqual(menu.map((e) => e.option), ["Withdraw-1", "Edit-tags", "Examine", "Cancel"]);
    // This client drops the bank's op 11 Examine: the option goes where it would be.
    const noExamine = plugin.transformMenuEntries(
        [{ option: "Withdraw-1", target: "x" }, { option: "Placeholder", target: "x" }, { option: "Cancel", target: "" }] as SimpleMenuEntry[],
        { surface: "widget", menu: true, widgetId: items.children![1]!.uid, childIndex: 1, itemId: WHIP },
    );
    assert.deepEqual(noExamine.map((e) => e.option), ["Withdraw-1", "Placeholder", "Edit-tags", "Cancel"]);
    menu[1].onClick!();
    assert.equal(prompts.at(-1)!.title, "Abyssal whip tags:<br>(append * for variation tag)");
    prompts.pop()!.onDone!("melee, slayer*");
    assert.equal(config.getConfiguration("banktags", "item_4151"), "melee");
    assert.equal(config.getConfiguration("banktags", `item_-${mapVariation(WHIP)}`), "slayer");
    plugin.tagManager.addTag(PLATEBODY, "melee", false);
    assert.equal(bankItemMenu(1)[1].option, "Edit-tags (2)");

    // A tag: search shows only tagged items, even ones whose names match.
    plugin.tagManager.addTag(SHARK, "food", false);
    vm.context.varManager.setVarcString(359, "tag:melee");
    // bankmain_filteritem, as the build calls it while searching.
    const filter = (item: number, search: string) => {
        vm.run(vm.context.loadScript(279), [item, 1], [search]);
        return vm.intStack[0];
    };
    assert.equal(filter(WHIP, "tag:melee"), 1);
    assert.equal(filter(SHARK, "tag:melee"), 0);
    assert.equal(filter(SHARK, "foo"), 1, "a plain search matches a tag too");
    assert.equal(filter(SHARK, "shark"), 1, "and names, as before");

    // Opening a tag tab: only its items.
    plugin.tabManager.add(plugin.tabManager.load("melee"));
    plugin.tabManager.save();
    plugin.openBankTag("melee");
    build();
    assert.deepEqual(shown().map(([, id]) => id), [WHIP, PLATEBODY], "the melee tab");
    assert.equal(manager.getWidgetByUid(Bankmain.TITLE)!.text, "Tag tab <col=ff0000>melee</col>");
    const tabWidgets = container.children!.slice(4);
    assert.equal(tabWidgets.length, 2, "the melee tab: background and icon");
    assert.equal(tabWidgets[0].spriteId, -202, "the open tab's background is the active one");

    // Remove-tag on an item in the tab.
    menu = bankItemMenu(shown()[0][0] as number);
    assert.ok(menu.some((e) => e.option === "Remove-tag (melee)"));

    // A layout: items where it puts them, whatever their bank order.
    const layout = new Layout("melee");
    layout.setItemAtPos(PLATEBODY, 0);
    layout.setItemAtPos(WHIP, 9);
    layout.setItemAtPos(PLATELEGS, 2); // tagged nowhere and not in the tab: a placeholder
    plugin.layoutManager.saveLayout(layout);
    plugin.openBankTag("melee");
    build();
    const laidOut = shown();
    const at = (id: number) => laidOut.find(([, item]) => item === id);
    assert.deepEqual(at(PLATEBODY)!.slice(0, 1), [0]);
    assert.deepEqual(at(WHIP)!.slice(0, 1), [9]);
    assert.deepEqual(at(WHIP)!.slice(2), [51 + 1 * 48, 36], "slot 9: second row, second column");
    assert.equal(items.children![2]!.itemId, PLATELEGS, "the bank has it, so it's drawn from the bank");

    // A layout placeholder's Duplicate/Remove are handled here, and a left click on one does nothing.
    const placeholderSlot = 20;
    const placeholderMenu = plugin.transformMenuEntries(
        [{ option: "Duplicate-item", target: "x" }, { option: "Remove-layout", target: "x" }, { option: "Cancel", target: "" }] as SimpleMenuEntry[],
        { surface: "widget", menu: true, widgetId: items.children![placeholderSlot]!.uid, childIndex: placeholderSlot, itemId: PLATELEGS },
    );
    assert.deepEqual(placeholderMenu.map((e) => e.option), ["Duplicate-item", "Remove-layout", "Cancel"], "nothing added to a placeholder");
    assert.ok(placeholderMenu[0].deprioritized && placeholderMenu[0].onClick);
    assert.equal(plugin.handleWidgetAction({ widget: items.children![placeholderSlot], option: "Duplicate-item", source: "primary" } as any), true);

    assert.ok((items.children![0] as any).jsListeners?.onDragComplete, "a laid-out item's drag rearranges the layout");

    // A withdraw from a laid-out slot goes to the item's real bank slot.
    const event: any = { widget: items.children![9], option: "Withdraw-1", slot: 9, itemId: WHIP, opIndex: 1 };
    plugin.handleWidgetAction(event);
    assert.equal(event.slot, 1, "the whip is in bank slot 1");

    // Export, then import into a fresh profile.
    const exported = plugin.tabInterface.exportTab(plugin.tabManager.find("melee")!);
    // -4151: the whip's variation key, which getItemsForTag lists (as RuneLite's does).
    assert.equal(exported, "banktags,1,melee,952,-4151,layout,0,1127,2,1079,9,4151");
    clearConfig();
    plugin.tabManager.clear();
    plugin.tabInterface.importFromClipboard(exported);
    assert.deepEqual(plugin.layoutManager.loadLayout("melee")!.getLayout().filter((id) => id !== -1), [PLATEBODY, PLATELEGS, WHIP]);
    assert.equal(messages.at(-1), "Tag tab 'melee' has been imported from your clipboard!");

    // A Grand Exchange search for tag:melee lists the tag's tradeable items.
    vm.context.varManager.setVarcString(359, "tag:melee");
    assert.equal([...vm.itemSearchListeners].some((listener: () => boolean) => listener()), true);
    assert.ok(vm.itemSearchResults.includes(WHIP) && vm.itemSearchResults.includes(PLATEBODY));
    assert.equal(vm.itemSearchCount, vm.itemSearchResults.length);
    vm.context.varManager.setVarcString(359, "");

    // Closing the tag: the whole bank again.
    plugin.closeBankTag();
    build();
    assert.equal(shown().length, 5);
    // The bank's own drag-complete script is back: the layout's listener is gone.
    assert.equal((items.children![0] as any).jsListeners?.onDragComplete, undefined);
    assert.ok((items.children![0] as any).eventHandlers?.onDragComplete);

    await plugin.stop();
    assert.equal(container.children, null, "the tab layer is removed");
    clearConfig();
    console.log("bank-tags tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
