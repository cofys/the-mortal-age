import { useCallback, useEffect, useRef, useState } from "react";

import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";

export interface OfficeInfo {
    office: string;
    title: string;
    description: string | null;
}

export interface StandingInfo {
    rank: string | null;
    office: OfficeInfo | null;
    tenureDays: number | null;
    warCouncilReady: boolean;
}

export interface KingdomInfo {
    id: string;
    name: string;
    capital: string | null;
    ruler: string | null;
    rulerTitle: string | null;
    treasury: number;
    situation: string | null;
    atWar: boolean;
    underSiege: boolean;
    inCivilWar: boolean;
    inSuccessionCrisis: boolean;
    vassalOf: string | null;
    vassalOfName: string | null;
    coalition: { name: string } | null;
}

export interface NewsItem {
    at: number | null;
    type: string;
    text: string;
}

export interface RealmInfo {
    id: string;
    name: string;
    ruler: string | null;
    relation: string | null;
    atWar: boolean;
    underSiege: boolean;
}

export interface MyKingdomStatus {
    open: boolean;
    kingdom: KingdomInfo | null;
    standing: StandingInfo | null;
    news: NewsItem[];
    realms: RealmInfo[];
    renounceResult?: { ok: boolean; spreadTo?: string[]; message?: string } | null;
}

function statusUrl(username: string, action?: string): string {
    const base = `/api/mykingdom-status?player=${encodeURIComponent(username)}`;
    return action ? `${base}&action=${action}` : base;
}

/**
 * Polls the `mykingdom-status` endpoint every 2s and carries the renounce flow.
 * Shared by the Town crier overlay and the sidebar tab — one source of truth for
 * the data, the notice, and the renounce confirmation state.
 *
 * Pass the client when the login screen should blank the panel (the overlay);
 * the sidebar panel omits it because the sidebar only renders while logged in.
 */
export function useMyKingdomStatus(osrsClient?: {
    isOnLoginScreen(): boolean;
} | null): {
    status: MyKingdomStatus | null;
    notice: string | null;
    confirmRenounce: boolean;
    setConfirmRenounce: (v: boolean) => void;
    doRenounce: () => Promise<void>;
    poll: () => Promise<void>;
    reset: () => void;
} {
    const [status, setStatus] = useState<MyKingdomStatus | null>(null);
    const [confirmRenounce, setConfirmRenounce] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const pollRef = useRef<number | undefined>(undefined);
    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient?.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(statusUrl(username))) as MyKingdomStatus;
            setStatus(data);
        } catch {
            // Stay hidden, retry next poll. Never throw in the poll loop.
        }
    }, [username, osrsClient]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 2000); // 2s poll — realm news moves slowly
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const doRenounce = useCallback(async () => {
        if (!username) return;
        setConfirmRenounce(false);
        try {
            const data = (await fetchContent(statusUrl(username, "renounce"))) as MyKingdomStatus;
            setStatus(data);
            setNotice(
                data.renounceResult?.ok
                    ? "Your oath is renounced. Seven days must pass before any court will take a new one."
                    : (data.renounceResult?.message ?? "The court did not release you.")
            );
        } catch {
            setNotice("The court could not be reached. Try again.");
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    const reset = useCallback(() => {
        setStatus(null);
        setConfirmRenounce(false);
        setNotice(null);
    }, []);

    return { status, notice, confirmRenounce, setConfirmRenounce, doRenounce, poll, reset };
}

/**
 * Marks the My Kingdom panel open/closed for the player. The Town crier path uses
 * this too; the sidebar tab drives it while selected so the server-side open state
 * always matches what the player sees. Never throws.
 */
export async function setMyKingdomOpen(open: boolean): Promise<void> {
    const username = connectionState.sessionUsername;
    if (!username) return;
    try {
        await fetchContent(statusUrl(username, open ? "open" : "close"));
    } catch {
        // The poll loop converges anyway.
    }
}
