import assert from "node:assert/strict";

import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { ClientScriptLoader } from "../game/cs2/ClientScriptLoader";
import { PrayerPlugin } from "../game/plugins/tabreorder/PrayerPlugin";
import { SpellbookPlugin } from "../game/plugins/tabreorder/SpellbookPlugin";
import {
    defaultOrder,
    moveSpell,
    prayerOrder,
    spellOrder,
    swapPrayers,
    visibleList,
} from "../game/plugins/tabreorder/tabReorder";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { createTypedArrayFromCode } from "../rs/cs2/Cs2ArrayObject";
import { Cs2Vm } from "../rs/cs2/Cs2Vm";
import { Opcodes } from "../rs/cs2/Opcodes";
import { Script } from "../rs/cs2/Script";
import {
    PRAYER_SORT_EVENT,
    QUICK_PRAYER_SORT_EVENT,
    SORT_CALLBACKS,
    SPELLBOOK_SORT_EVENT,
    addSortCallback,
} from "../rs/cs2/sortCallbacks";
import { FLAG_DRAG_ON } from "../widgets/WidgetFlags";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// --- Ordering rules ---------------------------------------------------------------------------

const book = [
    { index: 0, obj: 100, level: 13 },
    { index: 1, obj: 101, level: 1 },
    { index: 2, obj: 102, level: 5 },
    { index: 3, obj: 103, level: 5 },
];
assert.deepEqual(defaultOrder(book), [1, 2, 3, 0], "level, then enum index (the cache's sort key)");
assert.deepEqual(spellOrder(book, () => undefined), [1, 2, 3, 0]);
const saved = new Map([[100, 0], [101, 1]]);
assert.deepEqual(spellOrder(book, obj => saved.get(obj)), [0, 1, 2, 3], "saved positions win");
assert.deepEqual(spellOrder(book, obj => (obj === 100 ? 0 : undefined)), [1, 0, 2, 3], "ties keep the cache's order");

// Dragging inserts: the spells in between shift by one.
assert.deepEqual(moveSpell([1, 2, 3, 0], 0, 2), [[1, 2], [2, 0], [3, 1]]);
assert.deepEqual(moveSpell([1, 2, 3, 0], 3, 1), [[0, 1], [2, 2], [3, 3]]);
assert.deepEqual(moveSpell([1, 2, 3, 0], 2, 2), []);

assert.deepEqual(prayerOrder(book, undefined), [1, 2, 3, 0]);
assert.deepEqual(prayerOrder(book, [3, 9, 1]), [3, 1, 2, 0], "unknown ids dropped, new prayers appended");
assert.deepEqual(swapPrayers([1, 2, 3, 0], 1, 0), [0, 2, 3, 1], "dragging prayers swaps them");

const hidden = (index: number) => index === 2;
assert.deepEqual(visibleList([2, 0, 3], [3, 2, 0], hidden, false), [3, 0], "hidden left out, player's order");
assert.deepEqual(visibleList([2, 0, 3], [3, 2, 0], hidden, true), [3, 2, 0], "kept while reordering");
assert.deepEqual(visibleList([5, 0], [0], () => false, false), [0, 5], "unknown entries go last");

// --- The cache's sorts get their callbacks ----------------------------------------------------

const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const cache = CacheSystem.fromFiles(cacheInfo, loadCache(cacheInfo).files);
const scriptLoader = new ClientScriptLoader({ getCacheSystem: () => cache });
for (const callback of SORT_CALLBACKS) {
    const script = scriptLoader.load(callback.scriptId)!;
    const at = script.stringOperands.indexOf(callback.eventName);
    assert.ok(at > 0, `script ${callback.scriptId} has the ${callback.eventName} callback`);
    assert.equal(script.instructions[at + 1], Opcodes.RUNELITE_CALLBACK);
    assert.equal(script.instructions[at - 4], Opcodes.INVOKE);
    assert.equal(script.intOperands[at - 4], callback.sortScript);
}

// A patched script in the VM: the listener sees the enum, the length and the sorted array, and
// what it changes is what the script goes on with.
const SORT = 900;
const sort = new Script();
sort.id = SORT;
sort.intArgCount = 3;
sort.objArgCount = 1;
sort.instructions = Int32Array.from([Opcodes.RETURN]);
sort.intOperands = Int32Array.from([0]);
sort.stringOperands = [null];
const redraw = new Script();
redraw.id = 901;
redraw.localIntCount = 2;
redraw.localObjCount = 1;
const program: [number, number, string | null][] = [
    [Opcodes.ICONST, 4, null], [Opcodes.DEFINE_ARRAY, (0 << 16) | 105, null],
    ...[7, 8, 9, 10].flatMap((value, i): [number, number, string | null][] => [
        [Opcodes.ICONST, i, null], [Opcodes.ICONST, value, null], [Opcodes.SET_ARRAY_INT, 0, null],
    ]),
    [Opcodes.ICONST, 4, null], [Opcodes.ISTORE, 1, null],
    [Opcodes.ICONST, 5280, null], [Opcodes.ISTORE, 0, null],
    [Opcodes.OLOAD, 0, null], [Opcodes.ICONST, 0, null], [Opcodes.ILOAD, 1, null],
    [Opcodes.ICONST, 1, null], [Opcodes.SUB, 0, null], [Opcodes.ILOAD, 0, null], [Opcodes.INVOKE, SORT, null],
    // What the script draws: the length and the first entry.
    [Opcodes.ILOAD, 1, null], [Opcodes.ICONST, 0, null], [Opcodes.GET_ARRAY_INT, 0, null],
    [Opcodes.SCONST, 0, "drawn"], [Opcodes.RUNELITE_CALLBACK, 0, null],
    [Opcodes.RETURN, 0, null],
];
redraw.instructions = Int32Array.from(program.map(([op]) => op));
redraw.intOperands = Int32Array.from(program.map(([, operand]) => operand));
redraw.stringOperands = program.map(([, , text]) => text);
redraw.longOperands = new BigInt64Array(program.length);
assert.ok(addSortCallback(redraw, {
    scriptId: 901, sortScript: SORT, eventName: "testSort", enumLocal: 0, countLocal: 1, arrayLocal: 0,
}));
const vm = new Cs2Vm({
    widgetManager: { beginBatch() {}, endBatch() {} },
    loadScript: (id: number) => (id === SORT ? sort : undefined),
} as any);
const seen: unknown[] = [];
vm.scriptCallbackListeners.add((_script, name) => {
    const ints = vm.intStack.slice(0, vm.intStackSize);
    if (name === "testSort") {
        const array = vm.stringStack[vm.stringStackSize - 1];
        seen.push([name, ...ints.slice(-2), array.getInt(0), array.getInt(3)]);
        array.setAt(0, array.getInt(3));
        vm.intStack[vm.intStackSize - 1] = 2;
    } else {
        seen.push([name, ...ints.slice(-2)]);
        vm.intStackSize -= 2;
    }
});
vm.run(redraw);
assert.deepEqual(seen, [["testSort", 5280, 4, 7, 10], ["drawn", 2, 10]]);

// --- The plugins against a fake client -----------------------------------------------------

type FakeWidget = { uid: number; childIndex: number; actions?: (string | null)[]; hidden?: boolean; isHidden?: boolean; transparency?: number };
const widgets = new Map<number, FakeWidget>();
const flags = new Map<number, number>();
const invoked: [number, string][] = [];
const messages: string[] = [];
const varbits = new Map<number, number>();
const enums = new Map<number, { keys: number[]; intValues: number[] }>();
const objParams = new Map<number, Map<number, number>>();
const client: any = {
    widgetManager: {
        getWidgetByUid: (uid: number) => widgets.get(uid),
        getWidgetFlags: (w: FakeWidget) => flags.get(w.uid) ?? 0,
        setWidgetFlagsOverride: (w: FakeWidget, value: number) => flags.set(w.uid, value),
        invalidateWidgetRender() {},
        isEffectivelyHidden: () => false,
        getDynamicChildrenByParent: () => [],
    },
    cs2Vm: { invokeEventHandler: (w: FakeWidget, event: string) => invoked.push([w.uid, event]) },
    loaderFactory: { getEnumTypeLoader: () => ({ load: (id: number) => enums.get(id) }) },
    objTypeLoader: { load: (id: number) => ({ params: objParams.get(id) }) },
    varManager: { getVarbit: (id: number) => varbits.get(id) ?? 0 },
    addGameMessage: (text: string) => messages.push(text),
};
const widget = (uid: number): FakeWidget => {
    const w: FakeWidget = { uid, childIndex: -1, actions: [] };
    widgets.set(uid, w);
    return w;
};

/** Runs a sort callback as the patched script would: [enum, count] and the array. */
function sortCallback(plugin: SpellbookPlugin | PrayerPlugin, eventName: string, enumId: number, shown: number[]): number[] {
    const array = createTypedArrayFromCode(105, shown.length, shown.length);
    shown.forEach((index, i) => array.setAt(i, index));
    const fakeVm: any = {
        intStack: Int32Array.from([enumId, shown.length]), intStackSize: 2,
        stringStack: [array], stringStackSize: 1,
    };
    plugin.onScriptCallback({ eventName, vm: fakeVm });
    return Array.from({ length: fakeVm.intStack[1] }, (_, i) => array.getInt(i));
}

const SPELLBOOK = 1982;
const spellUid = (index: number) => (218 << 16) | (10 + index);
enums.set(SPELLBOOK, { keys: [0, 1, 2, 3], intValues: [100, 101, 102, 103] });
[13, 1, 5, 5].forEach((level, index) => {
    objParams.set(100 + index, new Map([[596, spellUid(index)], [604, level]]));
    widget(spellUid(index));
});
const magicStone = widget((548 << 16) | 70);
widget(218 << 16);

async function main(): Promise<void> {
    const config = inject(ConfigManager);
    const spellbook = new SpellbookPlugin(client);
    await spellbook.start();
    spellbook.onPostClientTick();
    assert.equal(magicStone.actions?.[9], "Enable spell reordering", "the Magic tab's stone op");

    assert.deepEqual(sortCallback(spellbook, SPELLBOOK_SORT_EVENT, SPELLBOOK, [1, 2, 3, 0]), [1, 2, 3, 0], "nothing saved: the cache's order");
    assert.deepEqual(sortCallback(spellbook, PRAYER_SORT_EVENT, SPELLBOOK, [3, 2]), [3, 2], "other lists untouched");

    // Enable reordering from the stone: spells become draggable and get Hide.
    assert.equal(spellbook.handleWidgetAction({ widget: magicStone, opIndex: 10 }), true);
    assert.deepEqual(messages, ["Spell book reordering is now enabled."]);
    assert.deepEqual(invoked.at(-1), [218 << 16, "onInvTransmit"], "the spellbook redraws");
    sortCallback(spellbook, SPELLBOOK_SORT_EVENT, SPELLBOOK, [1, 2, 3, 0]);
    assert.equal(widgets.get(spellUid(2))!.actions?.[5], "Hide");
    assert.ok(flags.get(spellUid(2))! & FLAG_DRAG_ON, "a drop target");

    // Drag the level-13 spell onto the first one, and hide the level-1 spell.
    assert.equal(spellbook.onWidgetDragComplete({ source: widgets.get(spellUid(0)), target: widgets.get(spellUid(1)) }), true);
    assert.equal(config.getConfiguration("spellbook", `spell_pos_book_${SPELLBOOK}_100`), "0");
    assert.equal(spellbook.handleWidgetAction({ widget: widgets.get(spellUid(1)), opIndex: 6 }), true);
    assert.equal(config.getConfiguration("spellbook", `spell_hidden_book_${SPELLBOOK}_101`), "true");
    assert.equal(widgets.get(spellUid(1))!.transparency, 100, "faded while reordering");
    assert.equal(widgets.get(spellUid(1))!.actions?.[5], "Unhide");
    assert.deepEqual(sortCallback(spellbook, SPELLBOOK_SORT_EVENT, SPELLBOOK, [1, 2, 3, 0]), [0, 1, 2, 3], "hidden spells still shown");

    // Lock again: the hidden spell is left out and hidden, nothing is draggable.
    spellbook.handleWidgetAction({ widget: magicStone, opIndex: 10 });
    assert.deepEqual(sortCallback(spellbook, SPELLBOOK_SORT_EVENT, SPELLBOOK, [1, 2, 3, 0]), [0, 2, 3]);
    assert.equal(widgets.get(spellUid(1))!.hidden, true);
    assert.equal(widgets.get(spellUid(2))!.actions?.[5], null);
    assert.equal(flags.get(spellUid(2))! & FLAG_DRAG_ON, 0);
    assert.equal(spellbook.onWidgetDragComplete({ source: widgets.get(spellUid(0)), target: widgets.get(spellUid(2)) }), false);

    spellbook.resetConfiguration();
    assert.deepEqual(config.getConfigurationKeys("spellbook.spell_"), [], "reset forgets order and hidden spells");
    await spellbook.stop();
    assert.equal(magicStone.actions?.[9], null, "the stone op goes with the plugin");

    // Prayers: dragging swaps, and the quick-prayer setup follows the order without hiding.
    const PRAYERS = 4956;
    const prayerUid = (index: number) => (541 << 16) | (9 + index);
    enums.set(PRAYERS, { keys: [0, 1, 2], intValues: [200, 201, 202] });
    [1, 4, 7].forEach((level, index) => {
        objParams.set(200 + index, new Map([[1751, prayerUid(index)], [1753, level]]));
        widget(prayerUid(index));
    });
    const prayerStone = widget((548 << 16) | 69);
    widget(541 << 16);
    const prayer = new PrayerPlugin(client);
    await prayer.start();
    sortCallback(prayer, PRAYER_SORT_EVENT, PRAYERS, [0, 1, 2]);
    prayer.handleWidgetAction({ widget: prayerStone, opIndex: 10 });
    assert.deepEqual(invoked.at(-1), [541 << 16, "onVarTransmit"]);
    prayer.onScriptFinished(547);
    assert.equal(widgets.get(prayerUid(0))!.actions?.[3], "Hide", "op 4");
    prayer.onWidgetDragComplete({ source: widgets.get(prayerUid(0)), target: widgets.get(prayerUid(2)) });
    assert.equal(config.getConfiguration("prayer", "prayer_order_book_0"), "2,1,0");
    prayer.handleWidgetAction({ widget: widgets.get(prayerUid(1)), opIndex: 4 });
    assert.equal(config.getConfiguration("prayer", "prayer_hidden_book_0_1"), "true");
    prayer.handleWidgetAction({ widget: prayerStone, opIndex: 10 });
    assert.deepEqual(sortCallback(prayer, PRAYER_SORT_EVENT, PRAYERS, [0, 1, 2]), [2, 0]);
    assert.deepEqual(sortCallback(prayer, QUICK_PRAYER_SORT_EVENT, PRAYERS, [0, 1, 2]), [2, 1, 0]);
    varbits.set(14826, 1);
    assert.deepEqual(sortCallback(prayer, PRAYER_SORT_EVENT, PRAYERS, [0, 1, 2]), [0, 1, 2], "each prayer book has its own order");
    await prayer.stop();
}

main().then(
    () => console.log("tab reordering ok"),
    error => {
        console.error(error);
        process.exit(1);
    },
);
