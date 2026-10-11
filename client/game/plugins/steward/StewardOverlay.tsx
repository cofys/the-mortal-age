import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { STEWARD_TOOLTIP } from "./StewardPlugin";
import { StewardView } from "./StewardView";
import { useStewardStatus } from "./useSteward";
import "./StewardOverlay.css";

/**
 * The in-world steward's-desk overlay: the same court menu, shown while the
 * server's `steward:open` flag is set for the player. Opens when the player
 * clicks a steward's desk in the world. While the sidebar's Steward's Desk
 * tab is selected the tab owns the panel, so the overlay stands down instead
 * of rendering the same content twice.
 */
export function StewardOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const {
        status,
        view,
        setView,
        confirmVacate,
        setConfirmVacate,
        notice,
        close,
        doPetition,
        doVacate,
        doRenounce,
        doPetitionJoin,
        doTakeOath,
    } = useStewardStatus(osrsClient);

    const sidebarSelected = useSyncExternalStore(
        useCallback(
            (listener: () => void) => osrsClient.sidebar.subscribe(listener),
            [osrsClient]
        ),
        () => osrsClient.sidebar.getState().selected
    );
    const stoodDown = sidebarSelected === STEWARD_TOOLTIP;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // While the tab owns the desk, Escape is not the overlay's to act
            // on — closing here would clear the flag the tab is driving.
            if (e.key === "Escape" && !stoodDown) close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [close, stoodDown]);

    if (!status?.open || stoodDown) return null;

    return (
        <div className="tma-steward-backdrop" onClick={close}>
            <div className="tma-steward-panel" onClick={(e) => e.stopPropagation()}>
                <button
                    className="tma-steward-close"
                    onClick={close}
                    aria-label="Close steward's desk"
                >
                    ✕
                </button>
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
            </div>
        </div>
    );
}
