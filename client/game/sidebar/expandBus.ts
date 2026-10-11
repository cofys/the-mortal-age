import { useCallback, useSyncExternalStore } from "react";

/**
 * Expand bus: lets a sidebar tab's small panel request the fullscreen overlay
 * for its feature, without driving the server's open flag.
 *
 * Driving the server flag from the tab is what caused the fullscreen flash:
 * the tab set `x:open` on mount and the overlay (which polls the flag)
 * rendered for a beat before its sidebar stand-down hid it. Tabs never touch
 * the flag now; the button below is the only path from small panel to
 * fullscreen.
 *
 * The overlay for each feature subscribes via useExpanded(key) and renders
 * fullscreen while expanded, even if its sidebar tab is selected (the
 * stand-down is bypassed). The overlay's close clears the expansion and the
 * server flag.
 */

const expanded = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** A tab's "Open fullscreen" button calls this. */
export function requestExpand(key: string): void {
    if (!expanded.has(key)) {
        expanded.add(key);
        emit();
    }
}

/**
 * A fullscreen overlay's close calls this (alongside clearing its server
 * flag), returning the feature to its small-panel state.
 */
export function clearExpand(key: string): void {
    if (expanded.delete(key)) emit();
}

export function isExpanded(key: string): boolean {
    return expanded.has(key);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** React binding for the fullscreen overlays. */
export function useExpanded(key: string): boolean {
    const getSnapshot = useCallback(() => isExpanded(key), [key]);
    return useSyncExternalStore(subscribe, getSnapshot);
}
