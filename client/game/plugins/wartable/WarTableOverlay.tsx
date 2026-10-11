import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { clearExpand, useExpanded } from "../../sidebar/expandBus";
import { WAR_COUNCIL_TOOLTIP } from "./WarTablePlugin";
import { WarTableView } from "./WarTableView";
import { useWarTableStatus } from "./useWarTable";
import "./WarTableOverlay.css";

/**
 * The in-world war table overlay: the same campaign map, shown when the
 * server's `wartable:open` flag is set for the player. While the sidebar's
 * War Council tab is selected the tab owns the panel, so the overlay stands
 * down instead of rendering the same content twice — unless the tab's "Open
 * fullscreen" button was used, which bypasses the stand-down.
 */
export function WarTableOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const {
        status,
        tab,
        setTab,
        selectedId,
        setSelectedId,
        warTargetId,
        setWarTargetId,
        warGoal,
        setWarGoal,
        busy,
        runAction,
        close,
    } = useWarTableStatus(osrsClient);

    const sidebarSelected = useSyncExternalStore(
        useCallback(
            (listener: () => void) => osrsClient.sidebar.subscribe(listener),
            [osrsClient]
        ),
        () => osrsClient.sidebar.getState().selected
    );
    const stoodDown = sidebarSelected === WAR_COUNCIL_TOOLTIP;
    const expanded = useExpanded(WAR_COUNCIL_TOOLTIP);

    const handleClose = useCallback(() => {
        clearExpand(WAR_COUNCIL_TOOLTIP);
        void close();
    }, [close]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // While the tab owns the table and the overlay is stood down,
            // Escape is not the overlay's to act on. When expanded, the
            // overlay is visible and Escape closes it.
            if (e.key === "Escape" && (!stoodDown || expanded)) handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose, stoodDown, expanded]);

    if ((!status?.open && !expanded) || (stoodDown && !expanded)) return null;

    return (
        <div className="tma-wartable-backdrop">
            <div className="tma-wartable-panel">
                <button
                    className="tma-wartable-close"
                    onClick={handleClose}
                    disabled={busy}
                    aria-label="Close war table"
                >
                    ✕
                </button>
                <WarTableView
                    status={status}
                    tab={tab}
                    onTabChange={setTab}
                    selectedId={selectedId}
                    onSelectKingdom={setSelectedId}
                    warTargetId={warTargetId}
                    onWarTargetChange={setWarTargetId}
                    warGoal={warGoal}
                    onWarGoalChange={setWarGoal}
                    busy={busy}
                    runAction={runAction}
                />
            </div>
        </div>
    );
}
