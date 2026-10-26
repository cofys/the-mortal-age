import { useCallback, useSyncExternalStore } from "react";

import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { imageIcon, runeliteImage } from "@runelite/client/ui/runeliteImages";
import type { NotesPlugin } from "./NotesPlugin";

/** The Notes plugin's sidebar panel: one text area, saved as you type. */
export function NotesPanel({ plugin }: { plugin: NotesPlugin }): JSX.Element {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const getSnapshot = useCallback(() => plugin.getState(), [plugin]);
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    return (
        <div className="rl-sidebar-panel-content">
            <textarea
                className="rl-sidebar-notes-input"
                value={state.config.notes}
                onChange={(event) => plugin.setConfig({ notes: event.target.value })}
                placeholder="Write your notes here."
                aria-label="Notes"
            />
        </div>
    );
}

/** The Notes button, at RuneLite's priority for it. */
export function createNotesNavigationButton(plugin: NotesPlugin): NavigationButton {
    return NavigationButton.builder()
        .tooltip("Notes")
        .icon(imageIcon(runeliteImage("notes_icon.png")))
        .priority(7)
        .panel(() => <NotesPanel plugin={plugin} />)
        .build();
}
