import { createChild, revalidate, setAction, setHidden } from "../../../widgets/custom/dynamicWidgets";
import { markWidgetInteractionDirty } from "../../../widgets/WidgetInteraction";
import { DRAG_DEPTH_SHIFT, FLAG_DRAG_ON } from "../../../widgets/WidgetFlags";
import type { WidgetManager } from "../../../widgets/WidgetManager";
import type { WidgetNode } from "../../../widgets/WidgetNode";

/** RuneLite's WidgetConfig.DRAG and DRAG_ON. */
export const WIDGET_DRAG = 1 << DRAG_DEPTH_SHIFT;
export const WIDGET_DRAG_ON = FLAG_DRAG_ON;

/** RuneLite's ItemQuantityMode. */
export const ItemQuantityMode = { NEVER: 0, ALWAYS: 1, STACKABLE: 2 } as const;

/**
 * RuneLite's Widget setters, as Bank Tags calls them, on this client's widgets. "original" x/y/
 * width/height are the raw values the layout reads; set them, then revalidate.
 */
export class BankWidgets {
    /** The client builds its widget manager after plugins are made: read it when used. */
    constructor(private readonly getManager: () => WidgetManager) {}

    get manager(): WidgetManager {
        return this.getManager();
    }

    createChild(parent: WidgetNode, type: number): WidgetNode {
        return createChild(this.manager, parent, type);
    }

    children(widget: WidgetNode | undefined): WidgetNode[] {
        return (widget?.children ?? []) as WidgetNode[];
    }

    child(widget: WidgetNode | undefined, index: number): WidgetNode | undefined {
        return this.children(widget)[index] ?? undefined;
    }

    /** Widget.setChildren(Arrays.copyOf(children, n)): drops the children from `n` on. */
    truncateChildren(widget: WidgetNode, n: number): void {
        const children = widget.children as WidgetNode[] | null;
        if (!children || children.length <= n) return;
        for (const dropped of children.slice(n)) if (dropped) this.manager.unregisterWidgetTree(dropped);
        children.length = n;
        this.manager.invalidateDynamicChildrenCache(widget);
        this.manager.invalidateWidgetRender(widget);
    }

    deleteAllChildren(widget: WidgetNode): void {
        for (const child of this.children(widget)) if (child) this.manager.unregisterWidgetTree(child);
        widget.children = null;
        this.manager.invalidateDynamicChildrenCache(widget);
        this.manager.invalidateWidgetRender(widget);
    }

    setHidden(widget: WidgetNode, hidden: boolean): void {
        setHidden(this.manager, widget, hidden);
    }

    isSelfHidden(widget: WidgetNode): boolean {
        return widget.hidden === true || (widget as any).isHidden === true;
    }

    isHidden(widget: WidgetNode): boolean {
        return this.manager.isEffectivelyHidden(widget.uid);
    }

    setOriginalX(widget: WidgetNode, x: number): void {
        widget.rawX = x;
    }

    setOriginalY(widget: WidgetNode, y: number): void {
        widget.rawY = y;
    }

    setOriginalWidth(widget: WidgetNode, width: number): void {
        widget.rawWidth = width;
    }

    setOriginalHeight(widget: WidgetNode, height: number): void {
        widget.rawHeight = height;
    }

    /** The laid-out size and position (RuneLite's getWidth/getHeight/getRelativeY). */
    width(widget: WidgetNode): number {
        this.manager.ensureLayout(widget);
        return widget.width | 0;
    }

    height(widget: WidgetNode): number {
        this.manager.ensureLayout(widget);
        return widget.height | 0;
    }

    relativeY(widget: WidgetNode): number {
        this.manager.ensureLayout(widget);
        return widget.y | 0;
    }

    revalidate(widget: WidgetNode): void {
        this.manager.beforeScriptLayoutChange(widget);
        revalidate(this.manager, widget);
    }

    /** Widget.setName: the menu target (CC_SETOPBASE). */
    setName(widget: WidgetNode, name: string): void {
        const w = widget as any;
        w.opBase = name;
        w.name = name;
        markWidgetInteractionDirty(widget);
    }

    getName(widget: WidgetNode | undefined): string {
        const w = widget as any;
        return String(w?.opBase ?? w?.name ?? "");
    }

    setAction(widget: WidgetNode, index: number, action: string): void {
        setAction(widget, index, action);
    }

    clearActions(widget: WidgetNode): void {
        const w = widget as any;
        w.actions = [];
        w.submenuActions = null;
        markWidgetInteractionDirty(widget);
    }

    /** Widget.setSubOp(op, subOp, text), both indices 0-based as RuneLite passes them. */
    setSubOp(widget: WidgetNode, op: number, subOp: number, text: string): void {
        const w = widget as any;
        if (!w.submenuActions) w.submenuActions = [];
        if (!w.submenuActions[op]) w.submenuActions[op] = [];
        w.submenuActions[op][subOp] = text;
        markWidgetInteractionDirty(widget);
    }

    setItem(widget: WidgetNode, itemId: number, quantity: number, mode?: number): void {
        const w = widget as any;
        w.itemId = itemId;
        w.itemQuantity = quantity;
        w.itemAmount = quantity;
        if (mode !== undefined) w.itemQuantityMode = mode;
        this.manager.invalidateWidgetRender(widget);
    }

    setItemQuantityMode(widget: WidgetNode, mode: number): void {
        (widget as any).itemQuantityMode = mode;
    }

    setBorderType(widget: WidgetNode, border: number): void {
        (widget as any).borderType = border;
    }

    setOpacity(widget: WidgetNode, opacity: number): void {
        widget.transparency = opacity;
        this.manager.invalidateWidgetRender(widget);
    }

    setSpriteId(widget: WidgetNode, spriteId: number): void {
        widget.spriteId = spriteId;
        this.manager.invalidateWidgetRender(widget);
    }

    setText(widget: WidgetNode, text: string): void {
        widget.text = text;
        this.manager.invalidateWidgetRender(widget);
    }

    /** Widget.setClickMask(getClickMask() | flags). */
    addClickMask(widget: WidgetNode, flags: number): void {
        this.manager.setWidgetFlagsOverride(widget, this.manager.getWidgetFlags(widget) | flags);
    }

    setDragDeadTime(widget: WidgetNode, cycles: number): void {
        const w = widget as any;
        w.dragThreshold = w.dragDeadTime = cycles;
    }

    setDragDeadZone(widget: WidgetNode, pixels: number): void {
        const w = widget as any;
        w.dragZoneSize = w.dragDeadZone = pixels;
    }

    setHasListener(widget: WidgetNode): void {
        (widget as any).hasListener = true;
        markWidgetInteractionDirty(widget);
    }

    setNoScrollThrough(widget: WidgetNode): void {
        (widget as any).noScrollThrough = true;
    }

    /** RuneLite's JavaScriptCallback listeners. */
    listen(widget: WidgetNode, listeners: Record<string, unknown>): void {
        const w = widget as any;
        w.jsListeners = { ...(w.jsListeners ?? {}), ...listeners };
        markWidgetInteractionDirty(widget);
    }

    /** Clears a JS listener so the widget's own script runs again. */
    unlisten(widget: WidgetNode, name: string): void {
        const w = widget as any;
        if (w.jsListeners) delete w.jsListeners[name];
    }

    /** Widget.setOnDragListener(Object... args): a script with magic-number args, or none. */
    setOnDragListener(widget: WidgetNode, args: unknown[] | null): void {
        const w = widget as any;
        w.onDrag = args;
        if (w.eventHandlers) delete w.eventHandlers.onDrag;
        markWidgetInteractionDirty(widget);
    }

    setScrollY(widget: WidgetNode, y: number): void {
        widget.scrollY = y;
        this.manager.invalidateScroll(widget);
    }

    /** RuneLite's getIndex: the child's index in its parent (-1 for a static component). */
    index(widget: WidgetNode | undefined): number {
        return (widget as any)?.childIndex ?? -1;
    }

    /** RuneLite's getId: for a dynamic child, its parent's component id. */
    id(widget: WidgetNode | undefined): number {
        const w = widget as any;
        if (!w) return -1;
        return w.fileId === -1 && typeof w.parentUid === "number" ? w.parentUid : w.uid;
    }

    parent(widget: WidgetNode | undefined): WidgetNode | undefined {
        const w = widget as any;
        return typeof w?.parentUid === "number" ? this.manager.getWidgetByUid(w.parentUid) : undefined;
    }
}
