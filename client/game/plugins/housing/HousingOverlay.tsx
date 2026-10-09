import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./HousingOverlay.css";

interface PlotInfo {
    kingdomId: string;
    kingdomName: string;
    claimedAt: number;
}

interface RoomInfo {
    key: string;
    name: string;
    level: number;
    cost: number;
    furnitureCount: number;
    furnitureValue: number;
}

interface TierInfo {
    key: string;
    name: string;
    min: number;
}

interface HouseInfo {
    owned: boolean;
    engineOwned: boolean;
    roomCount: number;
    furnitureCount: number;
    value: number;
    tier: TierInfo | null;
    rooms: RoomInfo[];
}

interface BoonInfo {
    room: string;
    skill: string;
    effect: string;
}

interface HousingStatus {
    open: boolean;
    plot: PlotInfo | null;
    plotCost: number;
    playerKingdom: { id: string; name: string } | null;
    house: HouseInfo;
    boons: BoonInfo[];
    doorMode: number;
    claim?: { ok: boolean; error?: string };
    doorModeResult?: { ok: boolean; error?: string };
}

function fmtCoins(n: number): string {
    return Math.floor(n).toLocaleString("en-US");
}

const DOOR_LABELS = ["Closed to visitors", "Open to visitors", "Open, no doors"];

export function HousingOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const [status, setStatus] = useState<HousingStatus | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const pollRef = useRef<number | undefined>(undefined);
    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/housing-status?player=${encodeURIComponent(username)}`
            )) as HousingStatus;
            setStatus(data);
            if (data.claim && !data.claim.ok && data.claim.error) setNotice(data.claim.error);
            if (data.doorModeResult && !data.doorModeResult.ok && data.doorModeResult.error)
                setNotice(data.doorModeResult.error);
        } catch {
            // Stay hidden, retry next poll. Never throw in the poll loop.
        }
    }, [username, osrsClient]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 2000);
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const handleClose = useCallback(async () => {
        setStatus(null);
        if (!username) return;
        try {
            await fetchContent(
                `/api/housing-status?player=${encodeURIComponent(username)}&action=close`
            );
        } catch {
            /* next poll sees open:false anyway */
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    const doAction = useCallback(
        async (action: string) => {
            if (!username) return;
            setNotice(null);
            try {
                await fetchContent(
                    `/api/housing-status?player=${encodeURIComponent(username)}&action=${action}`
                );
            } catch {
                /* poll will surface errors */
            }
            window.setTimeout(poll, 500);
        },
        [username, poll]
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose]);

    if (!status?.open) return null;

    const { plot, house } = status;

    return (
        <div className="tma-housing-backdrop" onClick={handleClose}>
            <div className="tma-housing-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-housing-close" onClick={handleClose} aria-label="Close">
                    ✕
                </button>
                <p className="tma-housing-kicker">Your estate</p>
                <h2 className="tma-housing-name">My House</h2>
                <div className="tma-housing-header-rule" />
                <div className="tma-housing-scroll">
                    {notice && <div className="tma-housing-notice">{notice}</div>}

                    <div className="tma-housing-section">
                        <h3 className="tma-housing-section-title">Housing Plot</h3>
                        <div className="tma-housing-inset">
                            {plot ? (
                                <>
                                    <div className="tma-housing-row">
                                        <span className="tma-housing-label">Kingdom</span>
                                        <span className="tma-housing-value">{plot.kingdomName}</span>
                                    </div>
                                    <p className="tma-housing-body">
                                        Your plot is claimed. Room boons are active while you are
                                        home, and the capital's citizens will gossip about grand
                                        houses.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p className="tma-housing-body">
                                        {status.playerKingdom
                                            ? `Claim a plot in ${status.playerKingdom.name} for ${fmtCoins(status.plotCost)} coins. A plot ties your house to the realm: room boons, citizen visitors, and standing.`
                                            : `You must belong to a kingdom before you can claim a housing plot.`}
                                    </p>
                                    {status.playerKingdom && (
                                        <button
                                            className="tma-housing-button"
                                            onClick={() => doAction("claim")}
                                        >
                                            Claim plot — {fmtCoins(status.plotCost)} coins
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    <div className="tma-housing-section">
                        <h3 className="tma-housing-section-title">The House</h3>
                        <div className="tma-housing-inset">
                            {house.tier && (
                                <div className="tma-housing-row">
                                    <span className="tma-housing-label">Standing</span>
                                    <span className="tma-housing-value tma-housing-tier">
                                        {house.tier.name}
                                    </span>
                                </div>
                            )}
                            <div className="tma-housing-row">
                                <span className="tma-housing-label">Value</span>
                                <span className="tma-housing-value">
                                    {fmtCoins(house.value)} coins
                                </span>
                            </div>
                            <div className="tma-housing-row">
                                <span className="tma-housing-label">Rooms</span>
                                <span className="tma-housing-value">{house.roomCount}</span>
                            </div>
                            <div className="tma-housing-row">
                                <span className="tma-housing-label">Furniture</span>
                                <span className="tma-housing-value">{house.furnitureCount} pieces</span>
                            </div>
                            {!house.engineOwned && (
                                <p className="tma-housing-body">
                                    You don't own a house yet. See the estate agent
                                    (Talk-to) to buy one, then build rooms in building mode
                                    with your Construction level and materials.
                                </p>
                            )}
                            {house.rooms.length > 0 && (
                                <ul className="tma-housing-roomlist">
                                    {house.rooms.map((r) => (
                                        <li key={r.key}>
                                            {r.name} — {r.furnitureCount} furnishing
                                            {r.furnitureCount === 1 ? "" : "s"}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>

                    {status.boons.length > 0 && (
                        <div className="tma-housing-section">
                            <h3 className="tma-housing-section-title">Room Boons</h3>
                            <div className="tma-housing-inset">
                                {status.boons.map((b) => (
                                    <p className="tma-housing-body" key={b.room}>
                                        <strong>{b.skill}:</strong> {b.effect}
                                    </p>
                                ))}
                            </div>
                        </div>
                    )}

                    {plot && (
                        <div className="tma-housing-section">
                            <h3 className="tma-housing-section-title">Visitors</h3>
                            <div className="tma-housing-inset">
                                <div className="tma-housing-row">
                                    <span className="tma-housing-label">House portal</span>
                                    <span className="tma-housing-value">
                                        {DOOR_LABELS[status.doorMode] ?? "Unknown"}
                                    </span>
                                </div>
                                <div className="tma-housing-buttonrow">
                                    {[0, 1, 2].map((m) => (
                                        <button
                                            key={m}
                                            className={
                                                "tma-housing-button tma-housing-button-small" +
                                                (status.doorMode === m ? " tma-housing-active" : "")
                                            }
                                            onClick={() => doAction(`doormode&mode=${m}`)}
                                        >
                                            {DOOR_LABELS[m]}
                                        </button>
                                    ))}
                                </div>
                                <p className="tma-housing-body">
                                    Friends can visit through your house portal while it is
                                    open. Citizens in your capital will gossip about grand
                                    houses on their own.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
