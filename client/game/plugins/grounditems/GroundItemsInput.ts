import { getMousePos } from "../../InputManager";
import type { GroundItemsPlugin, ItemBox } from "./GroundItemsPlugin";

const inBox = (box: ItemBox | undefined, x: number, y: number): box is ItemBox =>
    !!box && x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h;

/**
 * RuneLite's GroundItemHotkeyListener and GroundItemMouseAdapter: the hotkey held shows every
 * item with its list boxes, a double tap hides every label until the next press, and while it
 * is held, clicks on the boxes and names change the lists instead of reaching the game.
 */
export class GroundItemsInput {
    /** The mouse in UI canvas pixels, as the overlay draws. */
    mouse: [number, number] = [-1, -1];
    private lastPress?: number;
    private removeFilter?: () => void;

    constructor(
        private readonly plugin: GroundItemsPlugin,
        private readonly now: () => number = () => performance.now(),
    ) {}

    start(): void {
        const input = this.plugin.getClient().inputManager;
        if (input?.addInputFilter) this.removeFilter = input.addInputFilter(this.onInput);
        if (typeof window !== "undefined") window.addEventListener("blur", this.onBlur);
    }

    stop(): void {
        this.removeFilter?.();
        this.removeFilter = undefined;
        if (typeof window !== "undefined") window.removeEventListener("blur", this.onBlur);
        this.lastPress = undefined;
    }

    readonly onInput = (type: string, event: MouseEvent | KeyboardEvent): boolean => {
        if (type === "keyPressed") {
            if (!(event as KeyboardEvent).repeat) this.keyPressed(event as KeyboardEvent);
            return false;
        }
        if (type === "keyReleased") {
            this.keyReleased(event as KeyboardEvent);
            return false;
        }
        if (type === "mouseWheelMoved") return false;
        this.trackMouse(event as MouseEvent);
        if (type === "mousePressed") return this.mousePressed(event as MouseEvent);
        return false;
    };

    keyPressed(event: { keyCode: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): void {
        const plugin = this.plugin;
        if (!plugin.isStarted() || !plugin.config.hotkey().matches(event)) return;
        const delay = Number(plugin.config.doubleTapDelay()) || 0;
        const now = this.now();
        if (plugin.hideAll) {
            plugin.hideAll = false;
            plugin.hotKeyPressed = true;
            this.lastPress = undefined;
        } else if (this.lastPress !== undefined && !plugin.hotKeyPressed && delay > 0 && now - this.lastPress < delay) {
            plugin.hideAll = true;
            this.lastPress = undefined;
        } else {
            plugin.hotKeyPressed = true;
            this.lastPress = now;
        }
    }

    keyReleased(event: { keyCode: number }): void {
        const plugin = this.plugin;
        if (!plugin.config.hotkey().releasedBy(event)) return;
        this.release();
    }

    private release(): void {
        const plugin = this.plugin;
        plugin.hotKeyPressed = false;
        plugin.textBox = plugin.hiddenBox = plugin.highlightBox = undefined;
    }

    private readonly onBlur = () => this.release();

    private trackMouse(event: MouseEvent): void {
        const element = this.plugin.getClient().inputManager?.element;
        if (!element) return;
        const [x, y] = getMousePos(element, event);
        this.mouse = [x, y];
    }

    /** mousePressed: true when the click changed a list (consumed, so the player does not walk). */
    mousePressed(event: { button: number }): boolean {
        const plugin = this.plugin;
        if (!plugin.isStarted() || !plugin.hotKeyPressed) return false;
        const [x, y] = this.mouse;
        if (event.button === 0) {
            if (inBox(plugin.hiddenBox, x, y)) {
                plugin.updateList(plugin.hiddenBox.item.name, true);
                return true;
            }
            if (inBox(plugin.highlightBox, x, y)) {
                plugin.updateList(plugin.highlightBox.item.name, false);
                return true;
            }
            if (inBox(plugin.textBox, x, y)) {
                plugin.updateList(plugin.textBox.item.name, false);
                return true;
            }
        } else if (event.button === 2) {
            if (inBox(plugin.textBox, x, y)) {
                plugin.updateList(plugin.textBox.item.name, true);
                return true;
            }
        }
        return false;
    }
}
