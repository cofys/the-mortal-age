import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./HousingOverlay.css";

interface ResidenceInfo {
    id: string;
    name: string;
}

interface TownInfo {
    id: string;
    name: string;
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
    residence: ResidenceInfo | null;
    towns: TownInfo[];
    moveCost: number;
    house: HouseInfo;
    boons: BoonInfo[];
    doorMode: number;
    move?: { ok: boolean; error?: string; town?: TownInfo };
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
            if (data.move && !data.move.ok && data.move.error) setNotice(data.move.error);
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

    const [moveTown, setMoveTown] = useState<string>("");

    if (!status?.open) return null;

    const { residence, house } = status;
    const moveOptions = status.towns.filter((t) => !residence || t.id !== residence.id);
    const effectiveMoveTown =
        moveTown && moveOptions.some((t) => t.id === moveTown)
            ? moveTown
            : moveOptions[0]?.id ?? "";

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
                        <h3 className="tma-housing-section-title">Residence</h3>
                        <div className="tma-housing-inset">
                            {residence ? (
                                <>
                                    <div className="tma-housing-row">
                                        <span className="tma-housing-label">Home town</span>
                                        <span className="tma-housing-value">{residence.name}</span>
                                    </div>
                                    <p className="tma-housing-body">
                                        You are a resident of {residence.name}. Use any
                                        town's house portal to step inside your house, and
                                        the townsfolk will know you as one of their own.
                                    </p>
                                    <div className="tma-housing-row">
                                        <span className="tma-housing-label">Move to</span>
                                        <select
                                            className="tma-housing-select"
                                            value={effectiveMoveTown}
                                            onChange={(e) => setMoveTown(e.target.value)}
                                        >
                                            {moveOptions.map((t) => (
                                                <option key={t.id} value={t.id}>
                                                    {t.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <button
                                        className="tma-housing-button"
                                        onClick={() =>
                                            effectiveMoveTown &&
                                            doAction(`move&town=${effectiveMoveTown}`)
                                        }
                                    >
                                        Move residence — {fmtCoins(status.moveCost)} coins
                                    </button>
                                    <p className="tma-housing-body">
                                        Your house and everything in it moves with you. No
                                        rebuilding.
                                    </p>
                                </>
                            ) : (
                                <p className="tma-housing-body">
                                    You have no home town yet. Find the house portal in
                                    any town or city and step through it — the first one
                                    you use becomes your residence.
                                </p>
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

                    {residence && (
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
                                    open. Citizens in your home town will gossip about grand
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
