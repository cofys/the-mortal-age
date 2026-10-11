import { useEffect } from "react";

import { requestExpand } from "../../sidebar/expandBus";
import { WarTableView } from "./WarTableView";
import { WAR_COUNCIL_TOOLTIP } from "./WarTablePlugin";
import { setWarTableOpen, useWarTableStatus } from "./useWarTable";
import "./WarTableOverlay.css";
import "./WarTablePanel.css";

/**
 * The sidebar's War Council tab: the same campaign map as the in-world war
 * table overlay, in the rail panel. The tab never drives the server's
 * `wartable:open` flag (that caused the fullscreen flash on select); the
 * overlay stands down while this tab is selected, and the "Open fullscreen"
 * button below is the explicit path to the fullscreen overlay.
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
        void poll();
        return () => {
            void setWarTableOpen(false);
        };
    }, [poll]);

    return (
        <div className="tma-wartable-sidebar rl-sidebar-scrollable">
            <button
                className="tma-expand-fullscreen"
                onClick={() => requestExpand(WAR_COUNCIL_TOOLTIP)}
                title="Open the fullscreen war table view"
            >
                ⛶ Open fullscreen
            </button>
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
