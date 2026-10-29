/**
 * Tunables for mobile touch → OSRS click / camera mapping.
 */
export type TouchControlsConfig = {
    /** Hold duration (ms) before a stationary finger becomes a right-click. */
    holdMs: number;
    /**
     * Hold duration (ms) before moving a finger on an item in a scrolling list (the bank) drags
     * the item; moving sooner scrolls the list. Below {@link holdMs}, which opens the menu.
     */
    itemDragHoldMs: number;
    /** Movement (px, canvas space) before a pending touch becomes a drag / orbit. */
    dragThresholdPx: number;
    /** Multiplier applied to orbit deltas before they reach the camera. */
    orbitSensitivity: number;
    /**
     * When true, past-threshold one-finger drag orbits the camera (middle-mouse path).
     * When false (e.g. login world list), drag scrolls / cancels tap without orbiting.
     */
    enableCameraOrbit: boolean;
};

export const DEFAULT_TOUCH_CONTROLS: TouchControlsConfig = {
    holdMs: 450,
    itemDragHoldMs: 200,
    dragThresholdPx: 12,
    orbitSensitivity: 1,
    enableCameraOrbit: true,
};
