import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./JobBoardOverlay.css";

export interface BoardJob {
    id: string;
    kingdomId: string;
    type: string;
    title: string;
    detail: string;
    rewardGold: number;
    rewardInfluence: number;
    units: number;
    deliveredUnits: number;
    claimedBy: string | null;
    status: string;
    expiresAt: number | null;
}

export interface JobsStatus {
    open: boolean;
    jobs: BoardJob[];
    myClaims: BoardJob[];
    actionResult?: { ok: boolean; reason: string | null; paidGold: number | null } | null;
}

const TYPE_ORDER = ["soldier", "supply", "craft", "scout", "envoy", "sabotage", "builder", "bounty"];
const TYPE_LABELS: Record<string, string> = {
    soldier: "Soldiering",
    supply: "Supply contracts",
    craft: "Crafting contracts",
    scout: "Scouting",
    envoy: "Envoy missions",
    sabotage: "Sabotage",
    builder: "Repairs",
    bounty: "Bounties",
};

function jobsUrl(username: string, action?: string, jobId?: string): string {
    const base = `/api/jobs-status?player=${encodeURIComponent(username)}`;
    let url = action ? `${base}&action=${action}` : base;
    if (jobId) url += `&job=${encodeURIComponent(jobId)}`;
    return url;
}

function fmtCoins(n: number): string {
    return Math.floor(n).toLocaleString("en-US");
}

const REASON_LINES: Record<string, string> = {
    "not-at-target": "You are not there yet — the work is verified where it happens.",
    "deliveries-short": "The quartermaster has not received enough from you yet.",
    "materials-missing": "You do not carry the logs and iron bars the repair needs.",
    "treasury-cannot-pay": "The treasury cannot pay just now. The work stays yours.",
    "settled-on-the-field": "A soldier's pay is settled when the battle is decided.",
    "settled-by-the-kill": "A bounty is settled by the kill, not at the board.",
    caught: "You were caught. The victim's court has posted its own price.",
    "daily-cap": "The board gives no more of that work today.",
    "already-claimed": "Another hand took that work first.",
    unauthorized: "The board does not know your seal. Try again.",
};

/**
 * The Town crier's job board: work the realm actually needs, posted from
 * real wars, real shortages, real damage — and the wanted board. Shown
 * while the server's `jobs:open` flag is set for the player.
 */
export function JobBoardOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const [status, setStatus] = useState<JobsStatus | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const pollRef = useRef<number | undefined>(undefined);
    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(jobsUrl(username))) as JobsStatus;
            setStatus(data);
        } catch {
            // Stay hidden, retry next poll.
        }
    }, [username, osrsClient]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 2000);
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const act = useCallback(
        async (action: string, jobId: string) => {
            if (!username) return;
            try {
                const data = (await fetchContent(jobsUrl(username, action, jobId))) as JobsStatus;
                setStatus(data);
                const r = data.actionResult;
                if (r) {
                    if (r.ok) {
                        setNotice(
                            action === "complete" && r.paidGold
                                ? `Settled: ${fmtCoins(r.paidGold)}c from the treasury.`
                                : "Done. The board has it written down."
                        );
                    } else {
                        setNotice(REASON_LINES[r.reason ?? ""] ?? "The board refuses — for now.");
                    }
                }
            } catch {
                setNotice("The board could not be reached. Try again.");
            }
            window.setTimeout(poll, 500);
        },
        [username, poll]
    );

    const handleClose = useCallback(async () => {
        setStatus(null);
        if (!username) return;
        try {
            await fetchContent(jobsUrl(username, "close"));
        } catch {
            // The poll loop converges anyway.
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") void handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose]);

    if (!status?.open) return null;

    const board = status.jobs ?? [];
    const claims = status.myClaims ?? [];
    const bounties = board.filter((j) => j.type === "bounty");
    const work = board.filter((j) => j.type !== "bounty");
    const groups = TYPE_ORDER.map((t) => ({
        type: t,
        label: TYPE_LABELS[t] ?? t,
        jobs: work.filter((j) => j.type === t),
    })).filter((g) => g.jobs.length > 0);

    return (
        <div className="tma-jobs-backdrop" onClick={() => void handleClose()}>
            <div className="tma-jobs-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-jobs-close" onClick={() => void handleClose()} aria-label="Close">
                    ✕
                </button>
                <h2 className="tma-jobs-title">The Job Board</h2>
                <p className="tma-jobs-sub">
                    Work the realm needs, paid from the treasury when the work is proven.
                </p>
                {notice && <p className="tma-jobs-notice">{notice}</p>}

                {claims.length > 0 && (
                    <div className="tma-jobs-section">
                        <h3>Your work in hand</h3>
                        {claims.map((j) => (
                            <div key={j.id} className="tma-jobs-row">
                                <div className="tma-jobs-row-main">
                                    <span className="tma-jobs-row-title">{j.title}</span>
                                    <span className="tma-jobs-row-detail">{j.detail}</span>
                                    {j.units > 0 && (
                                        <span className="tma-jobs-row-detail">
                                            Delivered {j.deliveredUnits} / {j.units} units
                                        </span>
                                    )}
                                </div>
                                <div className="tma-jobs-row-actions">
                                    <button onClick={() => void act("complete", j.id)}>Complete</button>
                                    <button onClick={() => void act("abandon", j.id)}>Abandon</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {groups.map((g) => (
                    <div key={g.type} className="tma-jobs-section">
                        <h3>{g.label}</h3>
                        {g.jobs.map((j) => (
                            <div key={j.id} className="tma-jobs-row">
                                <div className="tma-jobs-row-main">
                                    <span className="tma-jobs-row-title">{j.title}</span>
                                    <span className="tma-jobs-row-detail">{j.detail}</span>
                                </div>
                                <div className="tma-jobs-row-actions">
                                    <span className="tma-jobs-reward">
                                        {fmtCoins(j.rewardGold)}c · +{j.rewardInfluence} standing
                                    </span>
                                    <button onClick={() => void act("claim", j.id)}>Claim</button>
                                </div>
                            </div>
                        ))}
                    </div>
                ))}

                {bounties.length > 0 && (
                    <div className="tma-jobs-section">
                        <h3>Wanted</h3>
                        {bounties.map((j) => (
                            <div key={j.id} className="tma-jobs-row tma-jobs-row-wanted">
                                <div className="tma-jobs-row-main">
                                    <span className="tma-jobs-row-title">{j.title}</span>
                                    <span className="tma-jobs-row-detail">{j.detail}</span>
                                </div>
                                <div className="tma-jobs-row-actions">
                                    <span className="tma-jobs-reward">{fmtCoins(j.rewardGold)}c</span>
                                    <button onClick={() => void act("claim", j.id)}>Take contract</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {board.length === 0 && claims.length === 0 && (
                    <p className="tma-jobs-empty">No work posted. The realm is quiet — for now.</p>
                )}
            </div>
        </div>
    );
}
