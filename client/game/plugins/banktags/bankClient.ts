import type { ObjType } from "../../../rs/config/objtype/ObjType";
import { type Cs2Vm, ExecutionState } from "../../../rs/cs2/Cs2Vm";
import type { Inventory } from "../../../rs/inventory/Inventory";
import type { WidgetManager } from "../../../widgets/WidgetManager";
import type { WidgetEventType, WidgetNode } from "../../../widgets/WidgetNode";
import { canonicalItemId } from "../inventorytags/inventoryTags";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import { BANK, INV, WORN } from "@runelite/api/gameval/InventoryID";

/**
 * What Bank Tags uses of the client: RuneLite's Client, ItemManager and ClientThread as the bank
 * tags code calls them. Tests give their own.
 */
export interface BankTagsClient {
    readonly widgets: WidgetManager;
    getWidget(componentId: number): WidgetNode | undefined;
    getItemDefinition(itemId: number): ObjType | undefined;
    /** ItemManager.canonicalize: a noted item or a placeholder is its item. */
    canonicalize(itemId: number): number;
    getItemCount(): number;
    /** InventoryID.BANK/INV/WORN, or undefined (the bank's while the bank isn't open). */
    getItemContainer(id: number): Inventory | undefined;
    getVarbitValue(id: number): number;
    setVarbit(id: number, value: number): void;
    getVarpValue(id: number): number;
    getVarcStrValue(id: number): string;
    setVarcIntValue(id: number, value: number): void;
    setVarcStrValue(id: number, value: string): void;
    /** The enum's int value for `key`, or -1. */
    getEnumIntValue(enumId: number, key: number): number;
    /** client.runScript: run now when no script is running, otherwise on the next client tick. */
    runScript(scriptId: number, ...args: (number | string)[]): void;
    /** Runs one of a widget's listeners (RuneLite's createScriptEventBuilder(listener).run()). */
    runListener(widget: WidgetNode, event: WidgetEventType): void;
    isShiftPressed(): boolean;
    playSoundEffect(id: number): void;
    /** ChatMessageManager: a CONSOLE message in the chatbox. */
    sendChatMessage(message: string): void;
    readonly vm?: Cs2Vm;
    /** The widget being dragged and the one under it (client.getDraggedWidget / getDraggedOnWidget). */
    getDraggedWidget(): WidgetNode | undefined;
    getDraggedOnWidget(): WidgetNode | undefined;
    setDraggedOnWidget(widget: WidgetNode | undefined): void;
}

export function osrsBankTagsClient(client: OsrsClient): BankTagsClient {
    const c = client as any;
    const vm = (): Cs2Vm | undefined => c.cs2Vm;
    const later: (() => void)[] = [];
    let flushing = false;
    const runningScript = () => vm()?.executionState === ExecutionState.RUNNING;
    const flush = () => {
        if (flushing || runningScript()) return;
        flushing = true;
        try {
            while (later.length) later.shift()!();
        } finally {
            flushing = false;
        }
    };
    const schedule = (fn: () => void) => {
        later.push(fn);
        if (!runningScript()) flush();
        else queueMicrotask(flush);
    };
    return {
        get widgets() {
            return c.widgetManager as WidgetManager;
        },
        get vm() {
            return vm();
        },
        getWidget: (id) => c.widgetManager?.getWidgetByUid?.(id),
        getItemDefinition: (id) => c.objTypeLoader?.load?.(id),
        canonicalize: (id) => canonicalItemId(id, (i) => c.objTypeLoader?.load?.(i)),
        getItemCount: () => c.objTypeLoader?.getCount?.() ?? 0,
        getItemContainer: (id) => {
            if (id === INV) return c.inventory;
            if (id === WORN) return c.equipment;
            if (id === BANK) return c.widgetManager?.getWidgetByUid?.((12 << 16) | 12) ? c.bankInventory : undefined;
            return undefined;
        },
        getVarbitValue: (id) => c.varManager?.getVarbit?.(id) ?? 0,
        setVarbit: (id, value) => c.varManager?.setVarbit?.(id, value),
        getVarpValue: (id) => c.varManager?.getVarp?.(id) ?? 0,
        getVarcStrValue: (id) => String(c.varManager?.getVarcString?.(id) ?? ""),
        setVarcIntValue: (id, value) => c.varManager?.setVarcInt?.(id, value),
        setVarcStrValue: (id, value) => c.varManager?.setVarcString?.(id, value),
        getEnumIntValue: (enumId, key) => {
            const e = c.loaderFactory?.getEnumTypeLoader?.()?.load?.(enumId);
            const i = e?.keys?.indexOf(key) ?? -1;
            return i >= 0 ? e.intValues[i] : (e?.defaultInt ?? -1);
        },
        runScript: (scriptId, ...args) =>
            schedule(() => {
                const v = vm();
                const script = v?.context?.loadScript?.(scriptId);
                if (!v || !script) return;
                v.run(script, args.filter((a): a is number => typeof a === "number"), args.filter((a) => typeof a === "string"));
            }),
        runListener: (widget, event) =>
            schedule(() => {
                const v = vm();
                if (!v) return;
                const w = widget as any;
                if (w.eventHandlers?.[event]) v.invokeEventHandler(widget, event);
                else if (Array.isArray(w[event]) && w[event].length) c.executeScriptListener?.(widget, w[event]);
            }),
        isShiftPressed: () => ClientState.isShiftPressed(),
        playSoundEffect: (id) => c.soundEffectSystem?.playSoundEffect?.(id, {}),
        sendChatMessage: (message) => c.addGameMessage?.(message),
        getDraggedWidget: () => {
            const s = c.getWidgetInteractionState?.();
            return s?.isDraggingWidget ? s.clickedWidget ?? undefined : undefined;
        },
        getDraggedOnWidget: () => c.getWidgetInteractionState?.()?.draggedOnWidget ?? undefined,
        setDraggedOnWidget: (widget) => {
            const s = c.getWidgetInteractionState?.();
            if (s) s.draggedOnWidget = widget ?? null;
        },
    };
}
