import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { WAR_COUNCIL_TOOLTIP } from "./WarTablePlugin";
import { WarTableView } from "./WarTableView";
import { useWarTableStatus } from "./useWarTable";
import "./WarTableOverlay.css";

/**
 * The in-world war table overlay: the same campaign map, shown when the
 * server's `wartable:open` flag is set for the player. While the sidebar's
 * War Council tab is selected the tab owns the panel, so the overlay stands
 * down instead of rendering the same content twice.
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

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // While the tab owns the table, Escape is not the overlay's to act
            // on — closing here would clear the flag the tab is driving.
            if (e.key === "Escape" && !stoodDown) void close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [close, stoodDown]);

    if (!status?.open || stoodDown) return null;

    return (
        <div className="tma-wartable-backdrop">
            <div className="tma-wartable-panel">
                <button
                    className="tma-wartable-close"
                    onClick={() => void close()}
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
