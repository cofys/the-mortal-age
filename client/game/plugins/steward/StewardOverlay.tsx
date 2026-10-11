import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { clearExpand, useExpanded } from "../../sidebar/expandBus";
import { STEWARD_TOOLTIP } from "./StewardPlugin";
import { StewardView } from "./StewardView";
import { useStewardStatus } from "./useSteward";
import "./StewardOverlay.css";

/**
 * The in-world steward's-desk overlay: the same court menu, shown while the
 * server's `steward:open` flag is set for the player. Opens when the player
 * clicks a steward's desk in the world. While the sidebar's Steward's Desk
 * tab is selected the tab owns the panel, so the overlay stands down instead
 * of rendering the same content twice — unless the tab's "Open fullscreen"
 * button was used, which bypasses the stand-down.
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
    const expanded = useExpanded(STEWARD_TOOLTIP);

    const handleClose = useCallback(() => {
        clearExpand(STEWARD_TOOLTIP);
        close();
    }, [close]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // While the tab owns the desk and the overlay is stood down,
            // Escape is not the overlay's to act on. When expanded, the
            // overlay is visible and Escape closes it.
            if (e.key === "Escape" && (!stoodDown || expanded)) handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose, stoodDown, expanded]);

    if ((!status?.open && !expanded) || (stoodDown && !expanded)) return null;

    return (
        <div className="tma-steward-backdrop" onClick={handleClose}>
            <div className="tma-steward-panel" onClick={(e) => e.stopPropagation()}>
                <button
                    className="tma-steward-close"
                    onClick={handleClose}
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
