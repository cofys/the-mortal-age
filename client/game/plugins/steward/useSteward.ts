import { useCallback, useEffect, useRef, useState } from "react";

import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";

export interface StewardOffice {
    officeId: string;
    title: string;
    vacant: boolean;
    holderName: string | null;
}

export interface StewardHeld {
    officeId: string;
    title: string;
}

export interface StewardInfluence {
    value: number;
    petitionThreshold: number;
    challengeThreshold: number;
    trial: { progress: number; target: number; daysLeft: number } | null;
}

export interface NaturalizationQuest {
    kingdomId: string;
    kingdomName: string;
    startedAt: number | null;
    influence: number;
    target: number;
    fee: number;
    feeCarried: number;
    cooldownDaysLeft: number;
    oathReady: boolean;
    blockers: string[];
}

export interface StewardStatus {
    open: boolean;
    /** Sidebar `action=open` only: true when the tab itself seated the player. */
    opened?: boolean;
    kingdom?: { id: string; name: string } | null;
    allegiance?: { id: string; name: string } | null;
    offices?: StewardOffice[];
    held?: StewardHeld[];
    influence?: StewardInfluence;
    naturalization?: NaturalizationQuest | null;
    ok?: boolean;
    message?: string;
}

export type StewardViewKind =
    | "menu"
    | "offices"
    | "petition"
    | "standing"
    | "resign"
    | "renounce"
    | "join";

function statusUrl(username: string, suffix?: string): string {
    const base = `/api/steward-status?player=${encodeURIComponent(username)}`;
    return suffix ? `${base}&${suffix}` : base;
}

/**
 * Polls the `steward-status` endpoint every 1s and carries the desk's UI
 * state (sub-view, vacate confirmation, notice) plus its actions. Shared by
 * the steward's-desk overlay and the sidebar's Steward's Desk tab — one
 * source of truth for the data and the court's rulings.
 *
 * Pass the client when the login screen should blank the panel (the overlay);
 * the sidebar panel omits it because the sidebar only renders while logged in.
 */
export function useStewardStatus(osrsClient?: {
    isOnLoginScreen(): boolean;
} | null): {
    status: StewardStatus | null;
    view: StewardViewKind;
    setView: (v: StewardViewKind) => void;
    confirmVacate: string | null;
    setConfirmVacate: (v: string | null) => void;
    notice: string | null;
    poll: () => Promise<void>;
    act: (action: string, extra?: string) => Promise<StewardStatus | null>;
    close: () => void;
    reset: () => void;
    doPetition: (officeId: string) => void;
    doVacate: (officeId: string) => void;
    doRenounce: () => Promise<void>;
    doPetitionJoin: () => Promise<void>;
    doTakeOath: () => Promise<void>;
} {
    const [status, setStatus] = useState<StewardStatus | null>(null);
    const [view, setView] = useState<StewardViewKind>("menu");
    const [confirmVacate, setConfirmVacate] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const pollRef = useRef<number | undefined>(undefined);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient?.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(statusUrl(username))) as StewardStatus;
            setStatus(data);
            if (!data.open) {
                setView("menu");
                setConfirmVacate(null);
            }
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

    const act = useCallback(
        async (action: string, extra = ""): Promise<StewardStatus | null> => {
            setNotice(null);
            try {
                const res = (await fetchContent(
                    statusUrl(username as string, `action=${action}${extra}`)
                )) as StewardStatus;
                window.setTimeout(poll, 500);
                return res;
            } catch {
                // Action failed silently; the chatbox may still show the ruling.
                window.setTimeout(poll, 500);
                return null;
            }
        },
        [username, poll]
    );

    const reset = useCallback(() => {
        setStatus(null);
        setView("menu");
        setConfirmVacate(null);
        setNotice(null);
    }, []);

    const close = useCallback(() => {
        setStatus(null);
        setView("menu");
        void act("close");
    }, [act]);

    const doPetition = useCallback(
        (officeId: string) => {
            void act("petition", `&office=${encodeURIComponent(officeId)}`);
            setNotice("Your petition is heard. Watch the chatbox for the court's ruling.");
        },
        [act]
    );

    const doVacate = useCallback(
        (officeId: string) => {
            void act("vacate", `&office=${encodeURIComponent(officeId)}`);
            setConfirmVacate(null);
            setView("menu");
            setNotice("The seals are laid down. The court will name another.");
        },
        [act]
    );

    const doRenounce = useCallback(async () => {
        const res = await act("renounce");
        setView("menu");
        setNotice(
            res?.message ??
                "Your oath is renounced. Seven days must pass before any court will take a new one."
        );
    }, [act]);

    const doPetitionJoin = useCallback(async () => {
        const res = await act("petition-join");
        setNotice(
            res?.message ??
                "Your petition is heard. Prove yourself through service to the realm."
        );
    }, [act]);

    const doTakeOath = useCallback(async () => {
        const res = await act("take-oath");
        setNotice(
            res?.message ?? "The oath is sworn. Rise, subject of the realm."
        );
    }, [act]);

    return {
        status,
        view,
        setView,
        confirmVacate,
        setConfirmVacate,
        notice,
        poll,
        act,
        close,
        reset,
        doPetition,
        doVacate,
        doRenounce,
        doPetitionJoin,
        doTakeOath,
    };
}

/**
 * Seats the player at a steward's desk for the sidebar tab (`action=open`).
 * A desk clicked in-world is never overridden; otherwise the player's own
 * court is used. Returns the endpoint's payload — `opened: true` means the
 * tab created the session and must clear it on close — or null on failure.
 * Never throws.
 */
export async function openStewardDesk(): Promise<StewardStatus | null> {
    const username = connectionState.sessionUsername;
    if (!username) return null;
    try {
        return (await fetchContent(statusUrl(username, "action=open"))) as StewardStatus;
    } catch {
        return null;
    }
}

/** Clears the steward's-desk session (`action=close`). Never throws. */
export async function closeStewardDesk(): Promise<void> {
    const username = connectionState.sessionUsername;
    if (!username) return;
    try {
        await fetchContent(statusUrl(username, "action=close"));
    } catch {
        // The poll loop converges anyway.
    }
}
