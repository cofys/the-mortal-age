import { strict as assert } from "node:assert";

import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { OverlayPosition } from "@runelite/client/ui/overlay/OverlayPosition";
import { OverlayRenderer } from "@runelite/client/ui/overlay/OverlayRenderer";
import type { WidgetOverlay, WidgetOverlayDrawContext } from "../game/plugins/ClientPluginManager";

// A window that only records the drag listeners, so the test can play the mouse.
const windowListeners = new Map<string, (event: any) => void>();
(globalThis as any).window = {
    addEventListener: (type: string, listener: (event: any) => void) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
};

// Resizable layout (161) on a 1000x600 canvas at 1 device pixel per layout unit.
let canvas = { w: 1000, h: 600 };
const widget = (x: number, y: number, w: number, h: number) => ({
    _absX: x, _absY: y, _absWidth: w, _absHeight: h, width: w, height: h,
});
const widgets = new Map<number, any>();
const layoutFor = () => {
    widgets.set((161 << 16) | 91, widget(0, 0, canvas.w, canvas.h)); // viewport
    widgets.set((161 << 16) | 15, widget(0, 0, canvas.w, canvas.h)); // HUD container
    widgets.set((161 << 16) | 96, widget(0, canvas.h - 165, 519, 165)); // chat container
};
layoutFor();

let filter: ((type: string, event: any) => boolean) | undefined;
const element = {
    get width() { return canvas.w; },
    get height() { return canvas.h; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.w, height: canvas.h }),
};
const client: any = {
    widgetManager: {
        rootInterface: 161,
        getWidgetByUid: (uid: number) => widgets.get(uid),
        isEffectivelyHidden: () => false,
    },
    inputManager: {
        element,
        addInputFilter(f: (type: string, event: any) => boolean) {
            filter = f;
            return () => (filter = undefined);
        },
    },
};

const config = new ConfigManager(undefined);
const renderer = new OverlayRenderer(client, config);
renderer.start();

const panel: WidgetOverlay = {
    signature: () => "",
    draw: () => [],
    movable: { name: "OpponentInfoOverlay", position: OverlayPosition.TOP_LEFT },
};
const PANEL_W = 129;
const PANEL_H = 38;

const drawn: { x: number; y: number; w: number; h: number }[] = [];
const context = {
    renderer: { drawRect: (x: number, y: number, w: number, h: number) => drawn.push({ x, y, w, h }) },
    fontLoader: () => undefined,
    sprite: () => undefined,
    place: () => undefined,
} as unknown as WidgetOverlayDrawContext;

/** One UI pass: the panel places itself, then the renderer draws last. */
function pass() {
    const at = renderer.placeOverlay(panel, PANEL_W, PANEL_H, canvas);
    drawn.length = 0;
    renderer.widgetOverlay.draw(context);
    return at;
}
const mouse = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    clientX: x, clientY: y, altKey: true, button: 0, ...extra,
});
const key = (type: string) => filter!(type, { key: "Alt" });
const saved = (suffix: string) => config.getConfiguration("runelite", `OpponentInfoOverlay${suffix}`);

// Default: RuneLite's TOP_LEFT, 5 in and below the mouse-over text.
assert.deepEqual(pass(), { x: 5, y: 20, scaleX: 1, scaleY: 1 });
assert.equal(drawn.length, 0, "no outlines without Alt");

// Without Alt the game gets the click.
assert.equal(filter!("mousePressed", mouse(50, 30, { altKey: false })), false);

// Alt outlines the overlay; a drag moves it and is kept from the game.
key("keyPressed");
assert.match(renderer.widgetOverlay.signature(), /^1,/);
pass();
assert.equal(drawn.length, 4, "an outline around the panel");
assert.equal(filter!("mousePressed", mouse(50, 30)), true, "the press starts a drag");
assert.equal(filter!("mouseMoved", mouse(60, 40)), true, "canvas moves are kept from the game");
windowListeners.get("mousemove")!(mouse(450, 330));
assert.deepEqual(pass(), { x: 405, y: 320, scaleX: 1, scaleY: 1 }, "follows the mouse at the grab offset");
windowListeners.get("mouseup")!(mouse(850, 230));
assert.ok(!windowListeners.has("mousemove") && !windowListeners.has("mouseup"), "drag listeners removed");
assert.equal(saved("_preferredLocation"), "-195:220", "saved from its nearest side");
assert.equal(saved("_originX"), "RIGHT");
assert.equal(saved("_originY"), "TOP");
assert.deepEqual(pass(), { x: 805, y: 220, scaleX: 1, scaleY: 1 });

// It keeps its distance from the right edge when the canvas grows.
canvas = { w: 1200, h: 600 };
layoutFor();
assert.deepEqual(pass(), { x: 1005, y: 220, scaleX: 1, scaleY: 1 });

// Dropped on a snap corner it locks there: TOP_RIGHT is 5 in from the HUD's right edge.
assert.equal(filter!("mousePressed", mouse(1010, 225)), true);
windowListeners.get("mouseup")!(mouse(1180, 20));
assert.equal(saved("_preferredPosition"), "TOP_RIGHT");
assert.equal(saved("_preferredLocation"), undefined, "a snapped overlay has no location");
assert.deepEqual(pass(), { x: 1200 - 5 - PANEL_W, y: 5, scaleX: 1, scaleY: 1 });

// Letting go of Alt hides the outlines; Alt + right-click resets it.
key("keyReleased");
pass();
assert.equal(drawn.length, 0);
key("keyPressed");
pass();
assert.equal(filter!("mousePressed", mouse(1100, 10, { button: 2 })), true);
assert.equal(saved("_preferredPosition"), undefined);
assert.deepEqual(pass(), { x: 5, y: 20, scaleX: 1, scaleY: 1 }, "back at TOP_LEFT");

// Positions come back from config in a new session.
config.setConfiguration("runelite", "OpponentInfoOverlay_preferredPosition", "BOTTOM_LEFT");
const next = new OverlayRenderer(client, config);
const at = next.placeOverlay(panel, PANEL_W, PANEL_H, canvas)!;
assert.deepEqual([at.x, at.y], [5, 600 - 165 - 5 - PANEL_H], "above the chatbox, 5 in");

renderer.stop();
console.log("overlay renderer test passed");
