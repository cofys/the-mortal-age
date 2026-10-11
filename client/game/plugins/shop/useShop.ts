import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";

export interface WareInfo {
    id: number;
    name: string;
    stock: number;
    price: number;
}

export interface StallSummary {
    owner: string;
    kingdomId: string;
    kingdomName: string;
    till: number;
    employee: string | null;
    weeklyRent: number;
    rentDebt: number;
    dailyWage: number;
    taxRate: number;
}

export interface StallRow {
    owner: string;
    kingdomName: string;
    wares: number;
    open: boolean;
    mine: boolean;
}

export interface KingdomLease {
    id: string;
    name: string;
    upfront: number;
    weeklyRent: number;
}

export interface SaleEntry {
    id: number;
    name: string;
    qty: number;
    total: number;
    buyer: string;
    at: number;
}

export interface ReturnEntry {
    id: number;
    name: string;
    qty: number;
}

export interface InvItem {
    id: number;
    name: string;
    qty: number;
}

export interface ShopStatus {
    open: boolean;
    view?: "board" | "manage" | "browse";
    notice?: string;
    hasStall?: boolean;
    myStall?: StallSummary | null;
    stalls?: StallRow[];
    kingdoms?: KingdomLease[];
    stall?: StallSummary;
    wares?: WareInfo[];
    inventory?: InvItem[];
    sales?: SaleEntry[];
    returns?: ReturnEntry[];
    hireCandidates?: string[];
    maxWares?: number;
}

export function shopApiUrl(username: string, extra: string): string {
    return `/api/shop-status?player=${encodeURIComponent(username)}${extra}`;
}

export function timeAgo(at: number): string {
    const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export interface ShopControls {
    status: ShopStatus | null;
    banner: string | null;
    qty: Record<string, string>;
    setQty: Dispatch<SetStateAction<Record<string, string>>>;
    price: Record<string, string>;
    setPrice: Dispatch<SetStateAction<Record<string, string>>>;
    collect: string;
    setCollect: Dispatch<SetStateAction<string>>;
    poll: () => Promise<void>;
    mutate: (extra: string) => Promise<void>;
    go: (view: "board" | "manage" | "browse", owner?: string) => void;
    qtyFor: (key: string) => number;
    reset: () => void;
}

/**
 * Polls the `shop-status` endpoint every 1s and carries every marketplace
 * mutation (lease, stock, price, buy, collect, claim, hire/fire, close).
 * Shared by the in-game marketplace overlay and the sidebar Stalls tab — one
 * source of truth for the data, the banner, and the form state.
 *
 * Pass the client when the login screen should blank the panel (the overlay);
 * the sidebar panel omits it because the sidebar only renders while logged in.
 */
export function useShopStatus(osrsClient?: {
    isOnLoginScreen(): boolean;
} | null): ShopControls {
    const [status, setStatus] = useState<ShopStatus | null>(null);
    const [banner, setBanner] = useState<string | null>(null);
    const [qty, setQty] = useState<Record<string, string>>({});
    const [price, setPrice] = useState<Record<string, string>>({});
    const [collect, setCollect] = useState("");
    const pollRef = useRef<number | undefined>(undefined);
    const bannerTimer = useRef<number | undefined>(undefined);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient?.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(shopApiUrl(username, ""))) as ShopStatus;
            setStatus(data && data.open ? data : null);
        } catch {
            // Server unreachable or endpoint missing — stay hidden, retry next poll.
        }
    }, [username, osrsClient]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 1000);
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    useEffect(() => {
        return () => {
            if (bannerTimer.current !== undefined) window.clearTimeout(bannerTimer.current);
        };
    }, []);

    const showBanner = useCallback((text: string | undefined) => {
        if (!text) return;
        setBanner(text);
        if (bannerTimer.current !== undefined) window.clearTimeout(bannerTimer.current);
        bannerTimer.current = window.setTimeout(() => setBanner(null), 5000);
    }, []);

    const mutate = useCallback(
        async (extra: string) => {
            if (!username) return;
            try {
                const data = (await fetchContent(shopApiUrl(username, extra))) as ShopStatus;
                if (data && data.notice) showBanner(data.notice);
                if (data && data.open) setStatus(data);
                else if (data && !data.open) setStatus(null);
            } catch {
                showBanner("The market board is unreachable — try again.");
            }
            window.setTimeout(poll, 400);
        },
        [username, poll, showBanner]
    );

    const go = useCallback(
        (view: "board" | "manage" | "browse", owner?: string) => {
            const extra =
                view === "browse" && owner
                    ? `&view=browse&owner=${encodeURIComponent(owner)}`
                    : `&view=${view}`;
            void mutate(extra);
        },
        [mutate]
    );

    const qtyFor = useCallback(
        (key: string): number => {
            const raw = (qty[key] ?? "1").trim();
            const n = Math.floor(Number(raw));
            return n >= 1 ? n : 1;
        },
        [qty]
    );

    const reset = useCallback(() => {
        setStatus(null);
        setBanner(null);
    }, []);

    return {
        status,
        banner,
        qty,
        setQty,
        price,
        setPrice,
        collect,
        setCollect,
        poll,
        mutate,
        go,
        qtyFor,
        reset,
    };
}

/**
 * Marks the marketplace open/closed for the player, driving the server's
 * `shop:overlay-open` state the endpoint gates on. Opening asks for the plain
 * status first so a view the player already has going (manage/browse from the
 * in-game board) survives the handoff to the tab; only a closed board is
 * opened fresh at the market board view. Closing clears the state server-side
 * (`action=close`). Never throws — the poll loop converges anyway.
 */
export async function setShopOpen(open: boolean): Promise<void> {
    const username = connectionState.sessionUsername;
    if (!username) return;
    try {
        if (!open) {
            await fetchContent(shopApiUrl(username, "&action=close"));
            return;
        }
        const data = (await fetchContent(shopApiUrl(username, ""))) as ShopStatus;
        if (!data || !data.open) {
            await fetchContent(shopApiUrl(username, "&view=board"));
        }
    } catch {
        // The poll loop converges anyway.
    }
}
