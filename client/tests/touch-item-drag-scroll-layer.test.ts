import assert from "node:assert/strict";

import { InputManager } from "../game/InputManager";
import { TouchGestureRecognizer } from "../game/input/TouchGestureRecognizer";
import { isInTouchScrollLayer } from "../game/widgets/input/widgetTouchScrollInput";

// A bank-like list: a layer wired to scrollbar_vertical (wheel script 36) with more to show.
const bankItems = { uid: 1, type: 0, height: 100, scrollHeight: 400, parentUid: -1, onScroll: [36, 2, 1, 32] };
const bankItem = { uid: 3, type: 5, itemId: 995, parentUid: 1 };
// The LMS loadout grid (br_loadout:ainventory): a plain layer, nothing to scroll.
const loadout = { uid: 10, type: 0, height: 200, scrollHeight: 0, parentUid: -1 };
const loadoutItem = { uid: 11, type: 5, itemId: 385, parentUid: 10 };

const widgets = new Map<number, any>([bankItems, bankItem, loadout, loadoutItem].map((w) => [w.uid, w]));
const widgetManager = { getWidgetByUid: (uid: number) => widgets.get(uid) } as any;

assert.equal(isInTouchScrollLayer(bankItem, widgetManager), true, "bank items keep swipe scrolling");
assert.equal(isInTouchScrollLayer(loadoutItem, widgetManager), false, "loadout items drag");

// A list with everything already in view does not take the swipe.
bankItems.scrollHeight = 50;
assert.equal(isInTouchScrollLayer(bankItem, widgetManager), false, "nothing to scroll: drag");

// Bank items (#1500): a quick swipe scrolls, resting first then moving drags the item.
const types = (intents: Array<{ type: string }>) => intents.map((intent) => intent.type);
const bank = new TouchGestureRecognizer();
bank.fingerDown(100, 100, 0, false, "afterHold");
assert.ok(types(bank.fingerMove(100, 160, 100)).includes("orbitStart"), "a quick swipe scrolls the list");
assert.ok(!types(bank.fingerUp(100, 160, 200)).includes("widgetRelease"));

assert.deepEqual(types(bank.fingerDown(100, 100, 0, false, "afterHold")), ["move"], "nothing is pressed yet");
assert.deepEqual(types(bank.fingerMove(102, 101, 150)), ["move"], "a resting finger stays pending");
const picked = bank.fingerMove(160, 100, 250);
assert.deepEqual(types(picked), ["move", "widgetPress"], "moving after the hold picks the item up");
assert.deepEqual(picked[1], { type: "widgetPress", x: 100, y: 100 }, "pressed where the finger rested");
assert.deepEqual(types(bank.checkLongPress(1000)), [], "a dragged item cannot open the menu");
assert.deepEqual(types(bank.fingerMove(200, 120, 300)), ["move"]);
assert.deepEqual(types(bank.fingerUp(200, 120, 400)), ["move", "widgetRelease"]);

bank.fingerDown(100, 100, 0, false, "afterHold");
assert.deepEqual(types(bank.checkLongPress(500)), ["longPress"], "holding still still opens the menu");
assert.ok(types(bank.fingerMove(160, 100, 600)).includes("orbitStart"), "moving after the menu scrolls, as before");
bank.cancel();
bank.fingerDown(100, 100, 0, false, "afterHold");
assert.ok(types(bank.fingerUp(100, 100, 50)).includes("tap"), "a tap still withdraws");

// Through InputManager: LEFT goes down at the rested point once the item is picked up.
{
    const input: any = new InputManager();
    input.element = { width: 800, height: 400,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) };
    input.onCanvasTouchStart = () => "afterHold";
    const event = (x: number, y: number, ended = false) => {
        const touches = [{ clientX: x, clientY: y }];
        return { touches: ended ? [] : touches, changedTouches: touches, preventDefault() {} };
    };
    let now = 1000;
    input.nowMs = () => now;
    input.onTouchStart(event(100, 100));
    input.onFrameStart();
    assert.equal(input.isDragging(), false, "no press before the finger moves");
    input.onFrameEnd();
    now += 250;
    input.onTouchMove(event(160, 100));
    assert.equal(input.mouseWheelDown, false, "a picked-up bank item does not scroll the list");
    input.onFrameStart();
    assert.equal(input.isDragging(), true);
    assert.equal(input.clickX, 100, "the press lands on the item the finger rested on");
    input.onFrameEnd();
    input.onTouchEnd(event(160, 100, true));
    assert.equal(input.isDragging(), false);
    input.touchAdapter.destroy();
}

console.log("Touch item drag scroll layer test passed");
