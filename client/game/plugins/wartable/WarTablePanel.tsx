import { useEffect } from "react";

import { WarTableView } from "./WarTableView";
import { setWarTableOpen, useWarTableStatus } from "./useWarTable";
import "./WarTableOverlay.css";
import "./WarTablePanel.css";

/**
 * The sidebar's War Council tab: the same campaign map as the in-world war
 * table overlay, in the rail panel. While selected it drives the server's
 * `wartable:open` flag (the in-world path uses the same flag), so the open
 * state always matches what the player sees; the overlay stands down while
 * this tab is open.
 */
export function WarTablePanel(): JSX.Element {
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
        poll,
    } = useWarTableStatus();

    useEffect(() => {
        let live = true;
        void (async () => {
            await setWarTableOpen(true);
            if (live) void poll();
        })();
        return () => {
            live = false;
            void setWarTableOpen(false);
        };
    }, [poll]);

    return (
        <div className="tma-wartable-sidebar rl-sidebar-scrollable">
            {!status ? (
                <p className="tma-wartable-note tma-wartable-sidebar-loading">
                    Unrolling the campaign map…
                </p>
            ) : (
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
            )}
        </div>
    );
}
