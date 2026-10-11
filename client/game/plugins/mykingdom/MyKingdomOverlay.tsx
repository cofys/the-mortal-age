import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { clearExpand, useExpanded } from "../../sidebar/expandBus";
import { MY_KINGDOM_TOOLTIP } from "./MyKingdomPlugin";
import { MyKingdomView } from "./MyKingdomView";
import { setMyKingdomOpen, useMyKingdomStatus } from "./useMyKingdom";
import "./MyKingdomOverlay.css";

/**
 * The Town crier's My Kingdom overlay: the same heraldic panel, shown when the
 * server's `mykingdom:open` flag is set for the player. While the sidebar's
 * My Kingdom tab is selected the tab owns the panel, so the overlay stands down
 * instead of rendering the same content twice — unless the tab's "Open
 * fullscreen" button was used, which bypasses the stand-down.
 */
export function MyKingdomOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const { status, notice, confirmRenounce, setConfirmRenounce, doRenounce, poll, reset } =
        useMyKingdomStatus(osrsClient);

    const sidebarSelected = useSyncExternalStore(
        useCallback(
            (listener: () => void) => osrsClient.sidebar.subscribe(listener),
            [osrsClient]
        ),
        () => osrsClient.sidebar.getState().selected
    );
    const expanded = useExpanded(MY_KINGDOM_TOOLTIP);

    const handleClose = useCallback(async () => {
        clearExpand(MY_KINGDOM_TOOLTIP);
        reset();
        await setMyKingdomOpen(false);
        window.setTimeout(poll, 500);
    }, [poll, reset]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") void handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose]);

    if ((!status?.open && !expanded) || (sidebarSelected === MY_KINGDOM_TOOLTIP && !expanded))
        return null;

    return (
        <div className="tma-mykingdom-backdrop" onClick={() => void handleClose()}>
            <div className="tma-mykingdom-panel" onClick={(e) => e.stopPropagation()}>
                <button
                    className="tma-mykingdom-close"
                    onClick={() => void handleClose()}
                    aria-label="Close"
                >
                    ✕
                </button>
                <MyKingdomView
                    status={status}
                    notice={notice}
                    confirmRenounce={confirmRenounce}
                    onConfirmRenounce={setConfirmRenounce}
                    onRenounce={() => void doRenounce()}
                />
            </div>
        </div>
    );
}
