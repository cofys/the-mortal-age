import type { SidebarPersistence, SidebarState } from "./types";

/**
 * Which sidebar panel is open, by its NavigationButton's tooltip, and whether the sidebar is
 * hidden, saved between visits. The buttons themselves come from `ClientToolbar`; a remembered
 * panel whose plugin is now off simply doesn't open.
 */
export class SidebarStore {
    private readonly listeners = new Set<() => void>();
    private state: SidebarState;
    /** The panel Ctrl+F12 reopens: the last one open (RuneLite's panel history). */
    private lastSelected: string | null;

    constructor(private readonly persistence?: SidebarPersistence) {
        const saved = persistence?.load();
        this.state = {
            selected: saved?.open ? saved.selectedId : null,
            collapsed: saved?.collapsed === true,
        };
        this.lastSelected = saved?.selectedId ?? null;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getState(): SidebarState {
        return this.state;
    }

    /** The panel last open, open now or not. */
    getLastSelected(): string | null {
        return this.lastSelected;
    }

    /** Opens `tooltip`'s panel, or closes the panel with null. */
    select(tooltip: string | null): void {
        if (this.state.selected === tooltip) return;
        if (tooltip !== null) this.lastSelected = tooltip;
        this.update({ ...this.state, selected: tooltip });
    }

    /** An icon click: opens the panel, or closes it when it's already open (RuneLite). */
    toggle(tooltip: string): void {
        this.select(this.state.selected === tooltip ? null : tooltip);
    }

    /** Hides or shows the whole sidebar. The open panel comes back with it. */
    setCollapsed(collapsed: boolean): void {
        if (this.state.collapsed === collapsed) return;
        this.update({ ...this.state, collapsed });
    }

    /** Ctrl+F11 and the edge arrow (RuneLite's `toggleSidebar`). */
    toggleCollapsed(): void {
        this.setCollapsed(!this.state.collapsed);
    }

    private update(state: SidebarState): void {
        this.state = state;
        this.persistence?.save({
            open: state.selected !== null,
            selectedId: state.selected ?? this.lastSelected,
            collapsed: state.collapsed,
        });
        for (const listener of this.listeners) listener();
    }
}
