import { useEffect, useRef } from "react";

import { requestExpand } from "../../sidebar/expandBus";
import { STEWARD_TOOLTIP } from "./StewardPlugin";
import { StewardView } from "./StewardView";
import { closeStewardDesk, useStewardStatus } from "./useSteward";
import "./StewardOverlay.css";
import "./StewardPanel.css";

/**
 * The sidebar's Steward's Desk tab: the player's desk session, without the
 * walk. The tab never seats the player itself (that drove the server's
 * `steward:open` flag and caused the fullscreen flash on select); it shows
 * the active desk session, or the No Court state when there is none. While
 * selected, the in-world overlay stands down. The "Open fullscreen" button
 * is the explicit path to the fullscreen overlay.
 */
export function StewardPanel(): JSX.Element {
    const {
        status,
        view,
        setView,
        confirmVacate,
        setConfirmVacate,
        notice,
        poll,
        doPetition,
        doVacate,
        doRenounce,
        doPetitionJoin,
        doTakeOath,
    } = useStewardStatus();
    const openedRef = useRef(false);

    useEffect(() => {
        void poll();
        return () => {
            if (openedRef.current) void closeStewardDesk();
        };
    }, [poll]);

    return (
        <div className="tma-steward-sidebar rl-sidebar-scrollable">
            {status?.open && (
                <button
                    className="tma-expand-fullscreen"
                    onClick={() => requestExpand(STEWARD_TOOLTIP)}
                    title="Open the fullscreen steward's desk view"
                >
                    ⛶ Open fullscreen
                </button>
            )}
            {!status ? (
                <p className="tma-steward-note tma-steward-sidebar-loading">
                    The steward hurries to the desk…
                </p>
            ) : !status.open ? (
                <div>
                    <p className="tma-steward-kicker">The Steward&apos;s Desk</p>
                    <h2 className="tma-steward-name">No Court</h2>
                    <div className="tma-steward-header-rule" />
                    <p className="tma-steward-note">
                        The steward has no court to receive you for — you owe no
                        allegiance and no petition is before any court. Join a
                        kingdom at its steward&apos;s desk in the wilds, or
                        petition its court, and this desk will open.
                    </p>
                </div>
            ) : (
                <StewardView
                    status={status}
                    view={view}
                    setView={setView}
                    confirmVacate={confirmVacate}
                    setConfirmVacate={setConfirmVacate}
                    notice={notice}
                    doPetition={doPetition}
                    doVacate={doVacate}
                    doRenounce={doRenounce}
                    doPetitionJoin={doPetitionJoin}
                    doTakeOath={doTakeOath}
                />
            )}
        </div>
    );
}
