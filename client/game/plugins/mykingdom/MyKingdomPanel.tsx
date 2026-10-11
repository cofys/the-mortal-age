import { useEffect } from "react";

import { requestExpand } from "../../sidebar/expandBus";
import { MY_KINGDOM_TOOLTIP } from "./MyKingdomPlugin";
import { MyKingdomView } from "./MyKingdomView";
import { setMyKingdomOpen, useMyKingdomStatus } from "./useMyKingdom";
import "./MyKingdomOverlay.css";
import "./MyKingdomPanel.css";

/**
 * The sidebar's My Kingdom tab: the same heraldic content as the Town crier
 * overlay, in the rail panel. The tab never drives the server's
 * `mykingdom:open` flag (that caused the fullscreen flash on select); the
 * overlay stands down while this tab is selected, and the "Open fullscreen"
 * button below is the explicit path to the fullscreen overlay.
 */
export function MyKingdomPanel(): JSX.Element {
    const { status, notice, confirmRenounce, setConfirmRenounce, doRenounce } =
        useMyKingdomStatus();

    useEffect(() => {
        return () => {
            void setMyKingdomOpen(false);
        };
    }, []);

    return (
        <div className="tma-mykingdom-sidebar rl-sidebar-scrollable">
            <button
                className="tma-expand-fullscreen"
                onClick={() => requestExpand(MY_KINGDOM_TOOLTIP)}
                title="Open the fullscreen My Kingdom view"
            >
                ⛶ Open fullscreen
            </button>
            {!status ? (
                <p className="tma-mykingdom-note tma-mykingdom-sidebar-loading">
                    Consulting the court…
                </p>
            ) : (
                <MyKingdomView
                    status={status}
                    notice={notice}
                    confirmRenounce={confirmRenounce}
                    onConfirmRenounce={setConfirmRenounce}
                    onRenounce={() => void doRenounce()}
                />
            )}
        </div>
    );
}
