import { strict as assert } from "node:assert";
import { GameStateChanged } from "@runelite/api/events";
import { GameState } from "@runelite/api/GameState";
import {
    CHATBOX_MES_LAYER,
    CHATBOX_MES_TEXT,
    CHATBOX_MES_TEXT2,
    ChatboxPanelManager,
    RUNELITE_CHATBOX_PANEL,
} from "@runelite/client/game/chatbox/ChatboxPanelManager";
import type { ChatboxTextInput } from "@runelite/client/game/chatbox/ChatboxTextInput";
import { FONT_FANCY_8 } from "../ui/fonts";

/** RuneLite's FontID.QUILL_8. */
const FONT_QUILL_8 = 497;
assert.equal(FONT_FANCY_8, FONT_QUILL_8, "q8_full is RuneLite's QUILL_8");
import { runWidgetJsOp } from "../widgets/custom/dynamicWidgets";
import { deriveRawMenuEntriesForWidget } from "../widgets/menu/utils";

// --- A widget manager with just enough layout: MINUS width, centred x, absolute y --------------
function fakeWidgets() {
    const widgets = new Map<number, any>();
    let nextUid = 0x7f000;
    const parentOf = (w: any) => widgets.get(w.parentUid);
    const manager: any = {
        widgets,
        getGroup: () => undefined,
        getWidgetByUid: (uid: number) => widgets.get(uid) ?? null,
        allocateDynamicUid: () => nextUid++,
        registerWidget: (w: any) => widgets.set(w.uid, w),
        unregisterWidgetTree: (w: any) => widgets.delete(w.uid),
        invalidateDynamicChildrenCache: () => {},
        redrawn: new Set<number>(),
        invalidateWidgetRender(w: any) { manager.redrawn.add(w.uid); },
        invalidateWidget: () => {},
        ensureLayout(w: any) {
            const parent = parentOf(w);
            if (!parent) return;
            w.width = w.widthMode === 1 ? parent.width - (w.rawWidth ?? 0) : (w.rawWidth ?? 0);
            w.height = w.heightMode === 1 ? parent.height - (w.rawHeight ?? 0) : (w.rawHeight ?? 0);
            w.x = w.xPositionMode === 1 ? Math.trunc((parent.width - w.width) / 2) + (w.rawX ?? 0) : (w.rawX ?? 0);
            w.y = w.rawY ?? 0;
        },
    };
    const add = (uid: number, extra: any = {}) => widgets.set(uid, { uid, groupId: uid >>> 16, children: null, hidden: false, isHidden: false, ...extra });
    add(CHATBOX_MES_LAYER, { width: 486, height: 100, _absX: 10, _absY: 500, _absWidth: 486, _absHeight: 100 });
    add(CHATBOX_MES_TEXT);
    add(CHATBOX_MES_TEXT2);
    return manager;
}

function fakeClient() {
    const scripts: [number, number[]][] = [];
    const varcs = new Map<number, number>();
    const keyHandlers: any[] = [];
    const mouseHandlers: any[] = [];
    const client: any = {
        scripts, varcs, keyHandlers, mouseHandlers,
        widgetManager: fakeWidgets(),
        cs2Vm: { scriptPreListeners: new Set<(id: number) => void>() },
        varManager: { setVarcInt: (id: number, v: number) => varcs.set(id, v), getVarcInt: (id: number) => varcs.get(id) ?? -1 },
        inputManager: {
            mouseX: 0, mouseY: 0,
            addKeyHandler: (h: any) => { keyHandlers.push(h); return () => {}; },
            addMouseHandler: (h: any) => { mouseHandlers.push(h); return () => {}; },
        },
        runClientScriptWithInts(id: number, args: number[]) {
            scripts.push([id, args]);
            for (const listener of client.cs2Vm.scriptPreListeners) listener(id, null);
        },
    };
    return client;
}

// QUILL_8 stand-in: 5px a character, baseline 12.
const font: any = { measure: (s: string) => s.length * 5, ascent: 12 };
const key = (client: any, k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
    client.keyHandlers[0].onKeyDown({ key: k, ctrlKey: !!mods.ctrl, metaKey: false, altKey: false, shiftKey: !!mods.shift });
const children = (client: any) => (client.widgetManager.getWidgetByUid(CHATBOX_MES_LAYER).children ?? []).filter(Boolean);

// --- ChatboxTextMenuInput ------------------------------------------------------------------------
{
    const client = fakeClient();
    const manager = new ChatboxPanelManager(client, () => font);
    const picked: string[] = [];
    let closed = 0;
    manager.openTextMenuInput("Are you sure?").option("Yes", () => picked.push("yes")).option("No", () => picked.push("no"))
        .onClose(() => closed++).build();
    assert.equal(client.scripts.length, 0, "opens on the next client tick (invokeLater)");
    manager.onClientTick();
    assert.deepEqual(client.scripts, [[677, [0]]], "MESSAGE_LAYER_OPEN");
    assert.equal(client.varcs.get(5), RUNELITE_CHATBOX_PANEL, "MESLAYERMODE");
    assert.ok(client.widgetManager.getWidgetByUid(CHATBOX_MES_TEXT).hidden && client.widgetManager.getWidgetByUid(CHATBOX_MES_TEXT2).hidden);
    const [prompt, yes, no] = children(client);
    assert.deepEqual([prompt.text, prompt.textColor, prompt.fontId, prompt.rawY, prompt.rawHeight, prompt.xPositionMode, prompt.widthMode],
        ["Are you sure?", 0x800000, FONT_QUILL_8, 8, 24, 1, 1], "the title as RuneLite builds it");
    // y = 0 + 24 + 6 = 30; (100 - 30 - 8) / 2 = 31 > 30, so step 30 and y + (1 * 2) / 2.
    assert.deepEqual([yes.text, yes.rawY, no.text, no.rawY], ["Yes", 31, "No", 61], "RuneLite's spacing");
    assert.deepEqual(yes.actions, ["Continue"]);
    assert.equal(yes.textColor, 0, "black");
    yes.jsListeners.onMouseOver();
    assert.equal(yes.textColor, 0xffffff, "white on hover");
    yes.jsListeners.onMouseLeave();
    assert.equal(yes.textColor, 0);

    // The op is offered (as setOnOpListener + setHasListener does) and runs the option.
    assert.ok(deriveRawMenuEntriesForWidget(yes, false, () => 0).some((e) => e.option === "Continue"), "Continue is offered");
    assert.equal(key(client, "a"), false, "other keys reach the game");
    assert.equal(key(client, "2"), true, "2 picks No");
    assert.deepEqual(picked, ["no"]);
    manager.onClientTick();
    assert.deepEqual(client.scripts.at(-1), [299, [0, 1, 0]], "MESSAGE_LAYER_CLOSE");
    assert.equal(manager.getCurrentInput(), undefined);
    assert.equal(closed, 1);

    // A click (the op) picks too; Escape closes without picking.
    manager.openTextMenuInput("Again?").option("Yes", () => picked.push("yes")).build();
    manager.onClientTick();
    assert.ok(runWidgetJsOp({ widget: children(client)[1], opIndex: 1, option: "Continue" }));
    manager.onClientTick();
    assert.deepEqual(picked, ["no", "yes"]);
    manager.openTextMenuInput("Again?").option("Yes", () => picked.push("yes")).build();
    manager.onClientTick();
    assert.equal(key(client, "Escape"), true);
    manager.onClientTick();
    assert.equal(manager.getCurrentInput(), undefined, "Escape closes");
    assert.deepEqual(picked, ["no", "yes"]);

    // The game's own MESSAGE_LAYER_CLOSE, or logging out, closes it too.
    manager.openTextMenuInput("Game closes it").option("Yes", () => {}).build();
    manager.onClientTick();
    client.runClientScriptWithInts(299, [0, 1, 0]);
    assert.equal(manager.getCurrentInput(), undefined, "script 299 from elsewhere");
    manager.openTextMenuInput("Logout").option("Yes", () => {}).build();
    manager.onClientTick();
    manager.onGameStateChanged(new GameStateChanged(GameState.LOGIN_SCREEN));
    assert.equal(manager.getCurrentInput(), undefined, "logging out");
    assert.equal(key(client, "1"), false, "no panel, no keys taken");
    assert.throws(() => manager.openTextMenuInput("x").build(), /atleast 1 option/);
}

// --- ChatboxTextInput ----------------------------------------------------------------------------
{
    const client = fakeClient();
    const manager = new ChatboxPanelManager(client, () => font);
    let done: string | undefined;
    let changes = 0;
    let closed = 0;
    const input: ChatboxTextInput = manager.openTextInput("Tile label").value("abc")
        .onDone((v: string) => { done = v; }).onChanged(() => changes++).onClose(() => closed++).build();
    manager.onClientTick();
    const texts = () => children(client).filter((w: any) => w.type === 4).map((w: any) => w.text);
    const cursor = () => children(client).find((w: any) => w.type === 3 && w.textColor === 0xffffff);
    assert.deepEqual(texts(), ["Tile label", "abc"], "prompt and value");
    const prompt = children(client)[0];
    assert.deepEqual([prompt.textColor, prompt.rawY, prompt.fontId], [0x800000, 8, FONT_QUILL_8]);
    // The value is centred: (486 - 15) / 2 = 235; the cursor sits just left of the end.
    assert.equal(children(client).find((w: any) => w.text === "abc").rawX, 235);
    assert.deepEqual([cursor().rawX, cursor().rawY, cursor().rawWidth, cursor().rawHeight], [235 + 15 - 1, 50, 2, 12]);

    client.widgetManager.redrawn.clear();
    assert.equal(key(client, "d"), true, "typed characters are taken");
    assert.equal(input.getValue(), "abcd");
    const typed = children(client).find((w: any) => w.text === "abcd");
    assert.ok(typed && client.widgetManager.redrawn.has(typed.uid), "the new text is redrawn, not only laid out");
    key(client, "Backspace");
    key(client, "ArrowLeft");
    key(client, "x");
    assert.equal(input.getValue(), "abxc");
    key(client, "Home");
    key(client, "Delete");
    assert.equal(input.getValue(), "bxc");
    key(client, "End", { shift: true });
    assert.deepEqual([input.getCursorStart(), input.getCursorEnd()], [0, 3], "Shift + End selects");
    assert.ok(children(client).some((w: any) => w.type === 3 && w.textColor === 0x113399), "the selection's highlight");
    key(client, "Escape");
    assert.equal(manager.getCurrentInput(), input, "Escape with a selection only clears it");
    key(client, "a", { ctrl: true });
    key(client, "Z");
    assert.equal(input.getValue(), "Z", "typing replaces the selection");
    key(client, "é");
    assert.equal(input.getValue(), "Z", "outside 32-126: refused");
    key(client, "<");
    assert.ok(texts().includes("Z<lt>"), `escaped for the widget: ${JSON.stringify(texts())} value=${JSON.stringify(input.getValue())}`);
    assert.equal(key(client, "F1"), false, "function keys reach the game");
    assert.ok(changes >= 6);

    // The mouse: canvas point -> character, with the container at (10, 500).
    // "Z<" is 10px wide, centred at 238; clicking its left edge puts the cursor at 0.
    client.inputManager.mouseX = 10 + 238;
    client.inputManager.mouseY = 500 + 55;
    client.mouseHandlers[0].onMouseDown({ button: 0, shiftKey: false });
    assert.deepEqual([input.getCursorStart(), input.getCursorEnd()], [0, 0], "a click places the cursor");
    client.inputManager.mouseX = 10 + 248;
    client.mouseHandlers[0].onMouseMove({ buttons: 1, shiftKey: false });
    assert.deepEqual([input.getCursorStart(), input.getCursorEnd()], [0, 2], "a drag selects");

    // Enter: onDone, then close.
    key(client, "End");
    key(client, "Enter");
    assert.equal(done, "Z<");
    manager.onClientTick();
    assert.equal(manager.getCurrentInput(), undefined);
    assert.equal(closed, 1);

    // onDone returning false keeps it open; lines() wraps.
    const kept = manager.openTextInput("Keep").onDone(() => false).build();
    manager.onClientTick();
    key(client, "Enter");
    manager.onClientTick();
    assert.equal(manager.getCurrentInput(), kept);
    manager.close();
    manager.onClientTick();
    const wrapped = manager.openTextInput("Wrap").lines(2).value("word ".repeat(30)).build();
    manager.onClientTick();
    assert.equal(texts().length, 3, "the prompt and two lines");
    assert.ok(wrapped.getValue().length === 150);
    assert.throws(() => manager.openTextInput(undefined as any).build(), /prompt must be non-null/);
}

// --- Client ticks are only taken while there is something to do ---------------------------------
{
    const client = fakeClient();
    let ticks: (() => void) | undefined;
    let subscriptions = 0;
    const manager = new ChatboxPanelManager(client, () => font, (tick) => {
        subscriptions++;
        ticks = tick;
        return () => { ticks = undefined; };
    });
    assert.equal(ticks, undefined, "idle: no tick subscription");
    assert.equal(client.keyHandlers.length, 0, "input handlers wait for the first panel");
    manager.openTextMenuInput("Hi").option("Ok", () => {}).build();
    assert.ok(ticks, "subscribed once there is work");
    ticks!();
    assert.equal(client.keyHandlers.length, 1);
    ticks!();
    assert.ok(ticks, "kept while the panel is open (the cursor blinks)");
    manager.close();
    ticks!();
    assert.equal(ticks, undefined, "released when closed");
    assert.equal(subscriptions, 1);
}

console.log("chatbox-panel tests passed");
