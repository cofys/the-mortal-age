import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { clearExpand, useExpanded } from "../../sidebar/expandBus";
import { STALLS_TOOLTIP } from "./StallsPlugin";
import { ShopView } from "./ShopView";
import { setShopOpen, useShopStatus } from "./useShop";
import "./ShopOverlay.css";

/**
 * The in-game marketplace overlay: the same market board and stall management
 * as the sidebar Stalls tab, shown when the server's `shop:overlay-open`
 * state is set for the player (market board / registrar in the world). While
 * the sidebar's Stalls tab is selected the tab owns the panel, so the overlay
 * stands down instead of rendering the same content twice — unless the tab's
 * "Open fullscreen" button was used, which bypasses the stand-down.
 */
export function ShopOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const controls = useShopStatus(osrsClient);
    const { status, reset, poll } = controls;

    const sidebarSelected = useSyncExternalStore(
        useCallback(
            (listener: () => void) => osrsClient.sidebar.subscribe(listener),
            [osrsClient]
        ),
        () => osrsClient.sidebar.getState().selected
    );
    const expanded = useExpanded(STALLS_TOOLTIP);

    const handleClose = useCallback(async () => {
        clearExpand(STALLS_TOOLTIP);
        reset();
        await setShopOpen(false);
        window.setTimeout(poll, 500);
    }, [poll, reset]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") void handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose]);

    if ((!status?.open && !expanded) || (sidebarSelected === STALLS_TOOLTIP && !expanded))
        return null;

    return (
        <div className="tma-shop-backdrop" onClick={() => void handleClose()}>
            <div className="tma-shop-panel" onClick={(e) => e.stopPropagation()}>
                <button
                    className="tma-shop-close"
                    onClick={() => void handleClose()}
                    aria-label="Close"
                >
                    ✕
                </button>
                <ShopView
                    status={status}
                    banner={controls.banner}
                    qty={controls.qty}
                    setQty={controls.setQty}
                    price={controls.price}
                    setPrice={controls.setPrice}
                    collect={controls.collect}
                    setCollect={controls.setCollect}
                    go={controls.go}
                    mutate={controls.mutate}
                    qtyFor={controls.qtyFor}
                />
            </div>
        </div>
    );
}
