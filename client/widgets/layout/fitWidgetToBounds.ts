import type { WidgetLike } from "./WidgetLayout";
import type { WidgetManager, WidgetNode } from "../WidgetManager";

type Bounds = { x: number; y: number; width: number; height: number };
type RenderTransform = { scaleX: number; scaleY: number; offsetX: number; offsetY: number };

/** Keep native widget layout (including CS2 item slots) and fit its rendered surface. */
export function fitWidgetToBounds(
    widget: WidgetLike,
    bounds: Bounds,
    transform: RenderTransform,
): RenderTransform {
    const width = Math.max(1, widget.width ?? 0);
    const height = Math.max(1, widget.height ?? 0);
    const scale = Math.min(1, bounds.width / width, bounds.height / height);
    const scaleX = transform.scaleX * scale;
    const scaleY = transform.scaleY * scale;
    return {
        scaleX,
        scaleY,
        offsetX: Math.round(transform.offsetX +
            (bounds.x + (bounds.width - width * scale) / 2) * transform.scaleX -
            (widget.x ?? 0) * scaleX),
        offsetY: Math.round(transform.offsetY +
            (bounds.y + (bounds.height - height * scale) / 2) * transform.scaleY -
            (widget.y ?? 0) * scaleY),
    };
}

/** Full-screen mounts opt in to a separate, fitted render root in Fixed mode. */
export function prepareViewportFittedRoots(
    manager: WidgetManager,
    renderTransform: RenderTransform,
): WidgetNode[] {
    const roots: WidgetNode[] = [];
    const viewport = manager.getSceneViewportWidget();
    for (const { group } of manager.interfaceParents.values()) {
        for (const root of manager.getAllGroupRoots(group)) {
            if (!root.fitToViewport) continue;
            root.__renderSeparately = manager.rootInterface === 548 && !!viewport;
            if (!root.__renderSeparately || !viewport || manager.isEffectivelyHidden(root.uid)) continue;
            manager.ensureLayout(viewport);
            manager.ensureLayout(root);
            let x = viewport.x;
            let y = viewport.y;
            let parent = manager.getWidgetByUid(viewport.parentUid);
            while (parent) {
                manager.ensureLayout(parent);
                x += parent.x - parent.scrollX;
                y += parent.y - parent.scrollY;
                parent = manager.getWidgetByUid(parent.parentUid);
            }
            const transform = fitWidgetToBounds(root, {
                x, y, width: viewport.width, height: viewport.height,
            }, renderTransform);
            const fittedRoot = root as any;
            fittedRoot.__widgetRenderScaleX = transform.scaleX;
            fittedRoot.__widgetRenderScaleY = transform.scaleY;
            fittedRoot.__widgetRenderOffsetX = transform.offsetX;
            fittedRoot.__widgetRenderOffsetY = transform.offsetY;
            manager.registerRootWidget(root,
                Math.round(root.x * transform.scaleX + transform.offsetX),
                Math.round(root.y * transform.scaleY + transform.offsetY),
                Math.round(root.width * transform.scaleX),
                Math.round(root.height * transform.scaleY));
            roots.push(root);
        }
    }
    return roots;
}
