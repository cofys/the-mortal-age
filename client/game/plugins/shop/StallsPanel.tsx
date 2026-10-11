import { useEffect } from "react";

import { ShopView } from "./ShopView";
import { setShopOpen, useShopStatus } from "./useShop";
import "./ShopOverlay.css";
import "./StallsPanel.css";

/**
 * The sidebar's Stalls tab: the same marketplace content as the in-game
 * overlay, in the rail panel. While selected it drives the server's
 * `shop:overlay-open` state (the in-game board path uses the same state), so
 * the open state always matches what the player sees; the overlay stands down
 * while this tab is open.
 */
export function StallsPanel(): JSX.Element {
    const controls = useShopStatus();
    const { status } = controls;

    useEffect(() => {
        void setShopOpen(true);
        return () => {
            void setShopOpen(false);
        };
    }, []);

    return (
        <div className="tma-shop-sidebar rl-sidebar-scrollable">
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
