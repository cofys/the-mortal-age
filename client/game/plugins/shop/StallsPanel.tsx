import { useEffect } from "react";

import { requestExpand } from "../../sidebar/expandBus";
import { ShopView } from "./ShopView";
import { STALLS_TOOLTIP } from "./StallsPlugin";
import { setShopOpen, useShopStatus } from "./useShop";
import "./ShopOverlay.css";
import "./StallsPanel.css";

/**
 * The sidebar's Stalls tab: the same marketplace content as the in-game
 * overlay, in the rail panel. The tab never drives the server's
 * `shop:overlay-open` state (that caused the fullscreen flash on select); the
 * overlay stands down while this tab is selected, and the "Open fullscreen"
 * button below is the explicit path to the fullscreen overlay.
 */
export function StallsPanel(): JSX.Element {
    const controls = useShopStatus();
    const { status } = controls;

    useEffect(() => {
        return () => {
            void setShopOpen(false);
        };
    }, []);

    return (
        <div className="tma-shop-sidebar rl-sidebar-scrollable">
            <button
                className="tma-expand-fullscreen"
                onClick={() => requestExpand(STALLS_TOOLTIP)}
                title="Open the fullscreen marketplace view"
            >
                ⛶ Open fullscreen
            </button>
            {!status ? (
                <p className="tma-shop-empty tma-shop-sidebar-loading">
                    Unrolling the market board…
                </p>
            ) : (
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
            )}
        </div>
    );
}
