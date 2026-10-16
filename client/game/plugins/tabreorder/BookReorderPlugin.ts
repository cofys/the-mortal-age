import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import type { Cs2Vm } from "../../../rs/cs2/Cs2Vm";
import { isCs2ArrayObject } from "../../../rs/cs2/Cs2ArrayObject";
import { FLAG_DRAG_ON, DRAG_DEPTH_SHIFT, getTransmitActionBit } from "../../../widgets/WidgetFlags";
import { markWidgetInteractionDirty } from "../../../widgets/WidgetInteraction";
import type { WidgetEventType, WidgetNode } from "../../../widgets/WidgetNode";
import type { WidgetActionEvent } from "../../widgets/widgetActionPayload";
import type { OsrsClient } from "../../OsrsClient";
import type { ClientPlugin, ScriptCallbackEvent, WidgetDragEvent, WidgetOverlay } from "../ClientPluginManager";
import type { BookEntry } from "./tabReorder";

/** RuneLite's WidgetConfig.DRAG: drag within the parent (drag depth 1). */
const DRAG = 1 << DRAG_DEPTH_SHIFT;
/** The tab stone op that toggles reordering (unused by the cache's stone ops 1-2). */
const STONE_OP = 10;
/** RuneLite's reordering warning: a red layer at opacity 220 over the whole tab. */
const TINT: [number, number, number, number] = [1, 0, 0, (255 - 220) / 255];

export type BookWidget = BookEntry & { uid: number };

/** The list a sort callback hands over (rs/cs2/sortCallbacks.ts). */
export type SortedList = { enumId: number; shown: number[] };

/**
 * RuneLite's spell and prayer reordering, shared: "Enable/Disable … reordering" on the tab's
 * stone, a red tint while it is on, entries made draggable with a Hide/Unhide op, and the
 * cache's list sort followed by the player's order.
 */
export abstract class BookReorderPlugin extends Plugin implements ClientPlugin {
    protected readonly configManager = inject(ConfigManager);
    protected readonly client: OsrsClient;
    protected reordering = false;
    private readonly books = new Map<number, BookWidget[]>();

    protected abstract readonly noun: "Spell" | "Prayer";
    /** The tab's stones in the fixed, resizable and bottom-line top levels. */
    protected abstract readonly stones: readonly number[];
    /** The tab interface's root, which holds the redraw listener. */
    protected abstract readonly rootUid: number;
    protected abstract readonly redrawEvent: WidgetEventType;
    /** The entry op (1-based) that hides and unhides. */
    protected abstract readonly hideOp: number;
    /** obj params: the entry's component and its sort level. */
    protected abstract readonly componentParam: number;
    protected abstract readonly levelParam: number;

    readonly widgetOverlay: WidgetOverlay = {
        signature: () => {
            const root = this.tintedRoot();
            return root ? `${root._absX},${root._absY},${root._absWidth},${root._absHeight}` : "";
        },
        draw: ({ renderer }) => {
            const root = this.tintedRoot();
            if (!root) return [];
            const rect = { x: root._absX, y: root._absY, w: root._absWidth, h: root._absHeight };
            renderer.drawRect(rect.x, rect.y, rect.w, rect.h, TINT);
            return [rect];
        },
    };

    constructor(client?: OsrsClient) {
        super();
        this.client = client ?? inject<OsrsClient>(CLIENT_TOKEN);
    }

    protected override async startUp(): Promise<void> {
        this.reordering = false;
        this.redraw();
    }

    protected override async shutDown(): Promise<void> {
        this.reordering = false;
        this.syncStoneOption();
        for (const entries of this.books.values()) {
            for (const entry of entries) this.decorate(entry, false, false);
        }
        this.redraw();
    }

    onPostClientTick(): void {
        if (this.isStarted()) this.syncStoneOption();
    }

    handleWidgetAction(event: WidgetActionEvent): boolean {
        if (!this.isStarted()) return false;
        const uid = event.widget?.uid;
        if (this.stones.includes(uid) && event.opIndex === STONE_OP) {
            this.setReordering(!this.reordering);
            return true;
        }
        if (!this.reordering || event.opIndex !== this.hideOp) return false;
        const entry = this.entryForWidget(event.widget);
        if (!entry) return false;
        this.toggleHidden(entry);
        return true;
    }

    onWidgetDragComplete({ source, target }: WidgetDragEvent): boolean {
        if (!this.isStarted() || !this.reordering) return false;
        const from = this.entryForWidget(source);
        const to = this.entryForWidget(target);
        if (!from || !to) return false;
        if (from !== to) this.move(from, to);
        return true;
    }

    onScriptCallback(event: ScriptCallbackEvent): void {
        if (!this.isStarted()) return;
        const { vm } = event;
        const list = readSortedList(vm);
        if (!list) return;
        const next = this.sortList(event.eventName, list);
        if (next) writeSortedList(vm, next);
    }

    /** The list to draw instead, or undefined to leave it. */
    protected abstract sortList(eventName: string, list: SortedList): number[] | undefined;
    protected abstract isHidden(entry: BookWidget): boolean;
    protected abstract setHidden(entry: BookWidget, hidden: boolean): void;
    /** Drops `from` on `to` in the saved order. */
    protected abstract move(from: BookWidget, to: BookWidget): void;
    /** The book shown now, if its list has been drawn. */
    protected abstract currentBook(): BookWidget[] | undefined;
    /** Shows a hidden entry faded and its op as Hide/Unhide while reordering, or neither. */
    protected abstract decorate(entry: BookWidget, reordering: boolean, hidden: boolean): void;

    protected toggleHidden(entry: BookWidget): void {
        const hidden = !this.isHidden(entry);
        this.setHidden(entry, hidden);
        this.decorate(entry, true, hidden);
    }

    /** A book's entries (enum index, obj, level, component), from the cache. */
    protected book(enumId: number): BookWidget[] {
        let entries = this.books.get(enumId);
        if (entries) return entries;
        entries = [];
        const book = this.client.loaderFactory?.getEnumTypeLoader()?.load(enumId);
        book?.keys?.forEach((index, i) => {
            const obj = book.intValues?.[i] ?? -1;
            const params = this.client.objTypeLoader?.load(obj)?.params;
            const uid = Number(params?.get(this.componentParam) ?? -1);
            if (uid === -1) return;
            entries!.push({ index, obj, uid, level: Number(params?.get(this.levelParam) ?? 0) });
        });
        this.books.set(enumId, entries);
        return entries;
    }

    protected widget(entry: BookWidget): WidgetNode | undefined {
        return this.client.widgetManager?.getWidgetByUid(entry.uid);
    }

    /** Makes the entry draggable, a drop target and its hide op shown, or none of these. */
    protected setDraggable(entry: BookWidget, on: boolean): void {
        const manager = this.client.widgetManager;
        const w = this.widget(entry);
        if (!manager || !w) return;
        const bits = DRAG | FLAG_DRAG_ON | getTransmitActionBit(this.hideOp - 1);
        const flags = manager.getWidgetFlags(w);
        const next = on ? flags | bits : flags & ~bits;
        if (next !== flags) manager.setWidgetFlagsOverride(w, next);
    }

    protected setOp(w: WidgetNode, op: number, text: string | null): void {
        const actions = (w.actions ??= []);
        if ((actions[op - 1] ?? null) === text) return;
        actions[op - 1] = text as string;
        markWidgetInteractionDirty(w);
    }

    protected setTransparency(w: WidgetNode | undefined, transparency: number): void {
        if (!w || (w.transparency ?? 0) === transparency) return;
        w.transparency = transparency;
        this.client.widgetManager?.invalidateWidgetRender(w);
    }

    protected hide(w: WidgetNode | undefined): void {
        if (!w || w.hidden) return;
        w.hidden = true;
        w.isHidden = true;
        this.client.widgetManager?.invalidateWidgetRender(w);
    }

    /** Runs the tab's redraw (RuneLite's redrawSpellbook / redrawPrayers). */
    protected redraw(): void {
        const root = this.client.widgetManager?.getWidgetByUid(this.rootUid);
        if (root) this.client.cs2Vm?.invokeEventHandler(root, this.redrawEvent);
    }

    private entryForWidget(w: any): BookWidget | undefined {
        if (typeof w?.uid !== "number" || (w.childIndex ?? -1) !== -1) return undefined;
        return this.currentBook()?.find(entry => entry.uid === w.uid);
    }

    private setReordering(on: boolean): void {
        this.reordering = on;
        this.client.addGameMessage(`${this.noun} book reordering is now ${on ? "enabled" : "disabled"}.`);
        this.syncStoneOption();
        this.redraw();
    }

    /** Keeps the stone's toggle op, which the top level's scripts may reset. */
    private syncStoneOption(): void {
        const manager = this.client.widgetManager;
        if (!manager) return;
        const lower = this.noun.toLowerCase();
        const text = !this.isStarted()
            ? null
            : `${this.reordering ? "Disable" : "Enable"} ${lower} reordering`;
        for (const uid of this.stones) {
            const stone = manager.getWidgetByUid(uid);
            if (!stone) continue;
            this.setOp(stone, STONE_OP, text);
            const bit = getTransmitActionBit(STONE_OP - 1);
            const flags = manager.getWidgetFlags(stone);
            const next = text ? flags | bit : flags & ~bit;
            if (next !== flags) manager.setWidgetFlagsOverride(stone, next);
        }
    }

    private tintedRoot(): any {
        if (!this.isStarted() || !this.reordering) return undefined;
        const manager = this.client.widgetManager;
        const root: any = manager?.getWidgetByUid(this.rootUid);
        if (!root || manager!.isEffectivelyHidden(this.rootUid) || !(root._absWidth > 0)) return undefined;
        return root;
    }
}

/** The enum, length and array a sort callback pushed. */
export function readSortedList(vm: Cs2Vm): SortedList | undefined {
    if (vm.intStackSize < 2 || vm.stringStackSize < 1) return undefined;
    const array = vm.stringStack[vm.stringStackSize - 1];
    if (!isCs2ArrayObject(array)) return undefined;
    const count = Math.min(vm.intStack[vm.intStackSize - 1], array.length);
    const shown: number[] = [];
    for (let i = 0; i < count; i++) shown.push(array.getInt(i));
    return { enumId: vm.intStack[vm.intStackSize - 2], shown };
}

/** Puts the list to draw back in the array and its length on the stack. */
export function writeSortedList(vm: Cs2Vm, list: readonly number[]): void {
    const array = vm.stringStack[vm.stringStackSize - 1];
    list.forEach((index, i) => array.setAt(i, index));
    vm.intStack[vm.intStackSize - 1] = list.length;
}
