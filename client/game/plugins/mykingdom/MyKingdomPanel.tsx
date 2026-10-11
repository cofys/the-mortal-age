import { useEffect } from "react";

import { MyKingdomView } from "./MyKingdomView";
import { setMyKingdomOpen, useMyKingdomStatus } from "./useMyKingdom";
import "./MyKingdomOverlay.css";
import "./MyKingdomPanel.css";

/**
 * The sidebar's My Kingdom tab: the same heraldic content as the Town crier
 * overlay, in the rail panel. While selected it drives the server's
 * `mykingdom:open` flag (the Town crier path uses the same flag), so the
 * open state always matches what the player sees; the overlay stands down
 * while this tab is open.
 */
export function MyKingdomPanel(): JSX.Element {
    const { status, notice, confirmRenounce, setConfirmRenounce, doRenounce } =
        useMyKingdomStatus();

    useEffect(() => {
        void setMyKingdomOpen(true);
        return () => {
            void setMyKingdomOpen(false);
        };
    }, []);

    return (
        <div className="tma-mykingdom-sidebar rl-sidebar-scrollable">
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
