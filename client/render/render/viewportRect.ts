/**
 * Scene viewport geometry, kept free of renderer imports so it can be tested.
 *
 * The viewport widget reports its size in layout units, so the rect is scaled
 * up to device pixels. When there is no viewport widget - the login screen, and
 * so the editor's scene preview - the fallback must be the layout size for the
 * same reason: using the device-pixel size scaled it twice, which on a HiDPI
 * display doubled the projection and pushed it off centre.
 */
export interface SceneViewportInput {
    /** Canvas size in device pixels. */
    fallbackWidth: number;
    fallbackHeight: number;
    /** Widget layout size, in layout units. */
    layoutWidth: number;
    layoutHeight: number;
    viewport?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        _absX?: number;
        _absY?: number;
        _absLogicalX?: number;
        _absLogicalY?: number;
    };
}

export interface SceneViewportRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The camera's device-pixel bounds after native viewport-shape/FOV clamping. */
export function getCameraViewportRect(camera: {
    viewportXOffset: number;
    viewportYOffset: number;
    viewportWidth: number;
    viewportHeight: number;
}): SceneViewportRect {
    return {
        x: camera.viewportXOffset,
        y: camera.viewportYOffset,
        width: camera.viewportWidth,
        height: camera.viewportHeight,
    };
}

export function computeSceneViewportRect(input: SceneViewportInput): SceneViewportRect {
    const fallbackWidth = Math.max(1, input.fallbackWidth | 0);
    const fallbackHeight = Math.max(1, input.fallbackHeight | 0);
    const layoutWidth = Math.max(1, (input.layoutWidth || fallbackWidth) | 0);
    const layoutHeight = Math.max(1, (input.layoutHeight || fallbackHeight) | 0);
    const scaleX = fallbackWidth / layoutWidth;
    const scaleY = fallbackHeight / layoutHeight;
    const viewport = input.viewport;

    const rawX =
        typeof viewport?._absLogicalX === "number"
            ? viewport._absLogicalX
            : typeof viewport?._absX === "number"
              ? Math.round(viewport._absX / scaleX)
              : typeof viewport?.x === "number"
                ? viewport.x
                : 0;
    const rawY =
        typeof viewport?._absLogicalY === "number"
            ? viewport._absLogicalY
            : typeof viewport?._absY === "number"
              ? Math.round(viewport._absY / scaleY)
              : typeof viewport?.y === "number"
                ? viewport.y
                : 0;
    const rawWidth = typeof viewport?.width === "number" ? viewport.width | 0 : layoutWidth;
    const rawHeight = typeof viewport?.height === "number" ? viewport.height | 0 : layoutHeight;

    return {
        x: Math.round(rawX * scaleX),
        y: Math.round(rawY * scaleY),
        width: Math.max(1, Math.round(rawWidth * scaleX)),
        height: Math.max(1, Math.round(rawHeight * scaleY)),
    };
}
