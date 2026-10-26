/** What the sidebar remembers between visits. */
export interface SidebarPersistedState {
    /** Whether a panel was open. */
    open: boolean;
    /** The open panel's button tooltip, or the last one open when none is. */
    selectedId: string | null;
    /** The whole sidebar hidden, icons included (RuneLite's `clientSidebarClosed`). */
    collapsed: boolean;
}

export interface SidebarPersistence {
    load(): SidebarPersistedState | undefined;
    save(state: SidebarPersistedState): void;
}

export interface SidebarState {
    /** The open panel's button tooltip, or null when no panel is open. */
    selected: string | null;
    /** The whole sidebar hidden, icons included (Ctrl+F11). */
    collapsed: boolean;
}
