import type { NavigationButton } from "@runelite/client/ui/NavigationButton";
import type { SidebarStore } from "./SidebarStore";

/** RuneLite's default keys: `sidebarToggleKey` (Ctrl+F11) and `panelToggleKey` (Ctrl+F12). */
export type SidebarShortcut = "toggleSidebar" | "togglePanel";

export function sidebarShortcut(event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
}): SidebarShortcut | null {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
    if (event.key === "F11") return "toggleSidebar";
    if (event.key === "F12") return "togglePanel";
    return null;
}

/**
 * Ctrl+F12: closes the open panel, or reopens the last one (the first panel when that plugin
 * is now off), as RuneLite's `togglePluginPanel`. Also shows a hidden sidebar.
 */
export function togglePanel(store: SidebarStore, buttons: ReadonlyArray<NavigationButton>): void {
    const { selected, collapsed } = store.getState();
    const open = buttons.some((button) => button.tooltip === selected && button.panel);
    if (open && !collapsed) {
        store.select(null);
        return;
    }
    const last = store.getLastSelected();
    const target =
        buttons.find((button) => button.tooltip === last && button.panel) ??
        buttons.find((button) => button.panel);
    store.setCollapsed(false);
    if (target) store.select(target.tooltip);
}
