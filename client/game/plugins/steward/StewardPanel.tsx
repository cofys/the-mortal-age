import { useEffect, useRef } from "react";

import { StewardView } from "./StewardView";
import { closeStewardDesk, openStewardDesk, useStewardStatus } from "./useSteward";
import "./StewardOverlay.css";
import "./StewardPanel.css";

/**
 * The sidebar's Steward's Desk tab: the player's own court's desk, without
 * the walk. Selecting the tab seats the player at their court via
 * `action=open`; the desk session is cleared on deselect ONLY when the tab
 * itself created it — a steward's desk clicked in-world is never ended by
 * the tab. While selected, the in-world overlay stands down.
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
        let live = true;
        void (async () => {
            const res = await openStewardDesk();
            openedRef.current = res?.opened === true;
            if (live) void poll();
        })();
        return () => {
            live = false;
            if (openedRef.current) void closeStewardDesk();
        };
    }, [poll]);

    return (
        <div className="tma-steward-sidebar rl-sidebar-scrollable">
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
