import { markWidgetInteractionDirty } from "../WidgetInteraction";
import type { WidgetManager } from "../WidgetManager";
import type { WidgetNode } from "../WidgetNode";

/** RuneLite's WidgetType. */
export const WidgetType = { LAYER: 0, RECTANGLE: 3, TEXT: 4, GRAPHIC: 5 } as const;
/** RuneLite's WidgetPositionMode. */
export const WidgetPositionMode = { ABSOLUTE_LEFT: 0, ABSOLUTE_CENTER: 1, ABSOLUTE_RIGHT: 2, ABSOLUTE_TOP: 0, ABSOLUTE_MIDDLE: 1, ABSOLUTE_BOTTOM: 2 } as const;
/** RuneLite's WidgetSizeMode. */
export const WidgetSizeMode = { ABSOLUTE: 0, MINUS: 1, PERCENT: 2 } as const;
/** RuneLite's WidgetTextAlignment. */
export const WidgetTextAlignment = { LEFT: 0, CENTER: 1, RIGHT: 2, TOP: 0, BOTTOM: 2 } as const;

/** An op on a widget, as the client dispatches it. */
export type WidgetOpEvent = { widget: WidgetNode; opIndex?: number; option?: string };

/**
 * RuneLite's JavaScriptCallback listeners: TS callbacks on a widget, called where the client
 * runs the matching CS2 listener (an op from a click or the menu, mouse over and leave).
 */
export type WidgetJsListeners = {
    onOp?: (event: WidgetOpEvent) => void;
    onMouseOver?: () => void;
    onMouseLeave?: () => void;
    /** The wheel over the widget: `mouseY` is the step, -1 up or 1 down (RuneLite's ScriptEvent). */
    onScrollWheel?: (event: { mouseY: number }) => void;
    /** Replaces the widget's drag-complete script; `target` is the widget it was dropped on. */
    onDragComplete?: (event: { source: WidgetNode; target: WidgetNode | null }) => void;
};

export function jsListeners(widget: WidgetNode | null | undefined): WidgetJsListeners | undefined {
    return (widget as { jsListeners?: WidgetJsListeners } | null | undefined)?.jsListeners;
}

/** Runs a widget's TS op listener for a click or menu op; true when it had one. */
export function runWidgetJsOp(event: WidgetOpEvent | { widget?: WidgetNode | null; opIndex?: number; option?: string }): boolean {
    const onOp = jsListeners(event.widget)?.onOp;
    if (!onOp || !event.widget) return false;
    try {
        onOp(event as WidgetOpEvent);
    } catch (error) {
        console.warn("[widgets] op listener failed", error);
    }
    return true;
}

/**
 * Widget.createChild(-1, type) from TS, as CC_CREATE builds a dynamic child: appended to the
 * parent's children, with CC_CREATE's defaults. Set fields, then call `revalidate`.
 */
export function createChild(widgetManager: WidgetManager, parent: WidgetNode, type: number): WidgetNode {
    if (!Array.isArray(parent.children)) parent.children = [];
    const childIndex = parent.children.length;
    const child = {
        uid: widgetManager.allocateDynamicUid(parent.groupId),
        id: parent.uid,
        parentUid: parent.uid,
        groupId: parent.groupId,
        fileId: -1,
        type,
        contentType: 0,
        childIndex,
        isIf3: true,
        hidden: false,
        isHidden: false,
        children: null,
        x: 0, y: 0, width: 0, height: 0,
        rawX: 0, rawY: 0, rawWidth: 0, rawHeight: 0,
        widthMode: 0, heightMode: 0, xPositionMode: 0, yPositionMode: 0,
        scrollX: 0, scrollY: 0, scrollWidth: 0, scrollHeight: 0,
        itemId: -1,
        itemQuantity: 0,
        isDraggable: false,
        actions: [],
        rootIndex: -1,
        cycle: -1,
        modelFrame: 0,
        modelFrameCycle: 0,
        aspectWidth: 1,
        aspectHeight: 1,
        isLayoutValid: false,
        color: 0,
        textColor: 0,
        filled: false,
        transparency: 0,
        text: "",
        textShadow: false,
        textShadowed: false,
        fontId: -1,
        xTextAlignment: 0,
        yTextAlignment: 0,
        lineHeight: 0,
        spriteId: -1,
        spriteId2: -1,
        params: new Map(),
    } as unknown as WidgetNode;
    parent.children.push(child);
    widgetManager.invalidateDynamicChildrenCache(parent);
    widgetManager.registerWidget(child);
    widgetManager.invalidateWidgetRender(parent);
    return child;
}

/** Widget.deleteAllChildren (CC_DELETEALL). */
export function deleteAllChildren(widgetManager: WidgetManager, widget: WidgetNode): void {
    if (Array.isArray(widget.children)) {
        for (const child of widget.children) if (child) widgetManager.unregisterWidgetTree(child);
    }
    widget.children = null;
    widgetManager.invalidateDynamicChildrenCache(widget);
    widgetManager.invalidateWidgetRender(widget);
}

/** Widget.setHidden (CC_SETHIDE). */
export function setHidden(widgetManager: WidgetManager, widget: WidgetNode, hidden: boolean): void {
    if (widget.hidden === hidden && widget.isHidden === hidden) return;
    widget.hidden = hidden;
    widget.isHidden = hidden;
    if (hidden) widgetManager.invalidateWidgetRender(widget);
    else widgetManager.invalidateWidget(widget);
}

/** Widget.setAction (CC_SETOP's 1-based index is index + 1). */
export function setAction(widget: WidgetNode, index: number, action: string): void {
    if (!widget.actions) widget.actions = [];
    (widget.actions as (string | null)[])[index] = action;
    markWidgetInteractionDirty(widget);
}

/** Widget.revalidate: lays the widget out again and redraws it (its text or colour may have changed). */
export function revalidate(widgetManager: WidgetManager, widget: WidgetNode): void {
    widgetManager.invalidateWidget(widget);
    widgetManager.invalidateWidgetRender(widget);
}

/** Widget.setTextColor: also redraws. */
export function setTextColor(widgetManager: WidgetManager, widget: WidgetNode, color: number): void {
    if (widget.textColor === color && widget.color === color) return;
    widget.textColor = color;
    widget.color = color;
    widgetManager.invalidateWidgetRender(widget);
}

/**
 * Widget.getCanvasLocation and size in canvas pixels, from where the renderer last drew it, and
 * the scale from widget to canvas pixels. Undefined before it has been drawn.
 */
export function canvasBounds(widget: WidgetNode): { x: number; y: number; scaleX: number; scaleY: number } | undefined {
    const w = widget as any;
    if (typeof w._absX !== "number" || typeof w._absY !== "number") return undefined;
    const scaleX = w.width > 0 && w._absWidth > 0 ? w._absWidth / w.width : 1;
    const scaleY = w.height > 0 && w._absHeight > 0 ? w._absHeight / w.height : 1;
    return { x: w._absX, y: w._absY, scaleX, scaleY };
}
