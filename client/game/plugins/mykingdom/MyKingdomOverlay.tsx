import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./MyKingdomOverlay.css";

interface OfficeInfo {
    office: string;
    title: string;
    description: string | null;
}

interface StandingInfo {
    rank: string | null;
    office: OfficeInfo | null;
}

interface KingdomInfo {
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

interface NewsItem {
    at: number | null;
    type: string;
    text: string;
}

interface RealmInfo {
    id: string;
    name: string;
    ruler: string | null;
    relation: string | null;
    atWar: boolean;
    underSiege: boolean;
}

interface MyKingdomStatus {
    open: boolean;
    kingdom: KingdomInfo | null;
    standing: StandingInfo | null;
    news: NewsItem[];
    realms: RealmInfo[];
}

function fmtCoins(n: number): string {
    return Math.floor(n).toLocaleString("en-US");
}

function fmtDate(ts: number | null): string {
    if (!ts) return "";
    try {
        return new Date(ts).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
        });
    } catch {
        return "";
    }
}

function realmAlerts(k: KingdomInfo): { label: string; tone: "danger" | "warn" | "gold" }[] {
    const out: { label: string; tone: "danger" | "warn" | "gold" }[] = [];
    if (k.underSiege) out.push({ label: "Under siege", tone: "danger" });
    else if (k.atWar) out.push({ label: "At war", tone: "danger" });
    if (k.inCivilWar) out.push({ label: "Civil war", tone: "danger" });
    else if (k.inSuccessionCrisis) out.push({ label: "Succession crisis", tone: "warn" });
    if (k.vassalOfName) out.push({ label: `Vassal of ${k.vassalOfName}`, tone: "warn" });
    if (k.coalition) out.push({ label: k.coalition.name, tone: "gold" });
    if (out.length === 0) out.push({ label: "At peace", tone: "gold" });
    return out;
}

export function MyKingdomOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const [status, setStatus] = useState<MyKingdomStatus | null>(null);
    const pollRef = useRef<number | undefined>(undefined);
    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/mykingdom-status?player=${encodeURIComponent(username)}`
            )) as MyKingdomStatus;
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

    const handleClose = useCallback(async () => {
        setStatus(null);
        if (!username) return;
        try {
            await fetchContent(
                `/api/mykingdom-status?player=${encodeURIComponent(username)}&action=close`
            );
        } catch {
            /* next poll sees open:false anyway */
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") handleClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleClose]);

    if (!status?.open) return null;

    const k = status.kingdom;
    const standing = status.standing;

    return (
        <div className="tma-mykingdom-backdrop" onClick={handleClose}>
            <div className="tma-mykingdom-panel" onClick={(e) => e.stopPropagation()}>
                <button
                    className="tma-mykingdom-close"
                    onClick={handleClose}
                    aria-label="Close"
                >
                    ✕
                </button>
                <p className="tma-mykingdom-kicker">The realm you serve</p>
                <h2 className="tma-mykingdom-name">{k ? k.name : "No Kingdom"}</h2>
                <div className="tma-mykingdom-header-rule" />
                <div className="tma-mykingdom-scroll">
                    {!k && (
                        <div className="tma-mykingdom-section">
                            <div className="tma-mykingdom-inset">
                                <p className="tma-mykingdom-body">
                                    You serve no kingdom yet. Your allegiance will be
                                    recorded here when you swear to a realm.
                                </p>
                            </div>
                        </div>
                    )}

                    {k && (
                        <>
                            <div className="tma-mykingdom-section">
                                <h3 className="tma-mykingdom-section-title">Your Standing</h3>
                                <div className="tma-mykingdom-inset">
                                    <div className="tma-mykingdom-row">
                                        <span className="tma-mykingdom-label">Rank</span>
                                        <span className="tma-mykingdom-value">
                                            {standing?.rank ?? "Subject"}
                                        </span>
                                    </div>
                                    {standing?.office && (
                                        <>
                                            <div className="tma-mykingdom-row">
                                                <span className="tma-mykingdom-label">Office</span>
                                                <span className="tma-mykingdom-value tma-mykingdom-gold">
                                                    {standing.office.title}
                                                </span>
                                            </div>
                                            {standing.office.description && (
                                                <p className="tma-mykingdom-note">
                                                    {standing.office.description}
                                                </p>
                                            )}
                                        </>
                                    )}
                                    {!standing?.office && (
                                        <p className="tma-mykingdom-note">
                                            Hold no office. Serve well and the court may notice.
                                        </p>
                                    )}
                                </div>
                            </div>

                            <div className="tma-mykingdom-section">
                                <h3 className="tma-mykingdom-section-title">The Realm</h3>
                                <div className="tma-mykingdom-inset">
                                    <div className="tma-mykingdom-row">
                                        <span className="tma-mykingdom-label">Capital</span>
                                        <span className="tma-mykingdom-value">
                                            {k.capital ?? "—"}
                                        </span>
                                    </div>
                                    <div className="tma-mykingdom-row">
                                        <span className="tma-mykingdom-label">Ruler</span>
                                        <span className="tma-mykingdom-value">
                                            {k.ruler ?? "—"}
                                            {k.rulerTitle ? `, ${k.rulerTitle}` : ""}
                                        </span>
                                    </div>
                                    <div className="tma-mykingdom-row">
                                        <span className="tma-mykingdom-label">Treasury</span>
                                        <span className="tma-mykingdom-value tma-mykingdom-gold">
                                            {fmtCoins(k.treasury)} coins
                                        </span>
                                    </div>
                                    {k.situation && (
                                        <p className="tma-mykingdom-note">{k.situation}</p>
                                    )}
                                    <div className="tma-mykingdom-badges">
                                        {realmAlerts(k).map((a, i) => (
                                            <span
                                                key={i}
                                                className={`tma-mykingdom-badge tma-mykingdom-badge-${a.tone}`}
                                            >
                                                {a.label}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {status.news.length > 0 && (
                                <div className="tma-mykingdom-section">
                                    <h3 className="tma-mykingdom-section-title">Realm News</h3>
                                    <div className="tma-mykingdom-inset">
                                        {status.news.map((n, i) => (
                                            <div key={i} className="tma-mykingdom-news-item">
                                                <span className="tma-mykingdom-news-type">
                                                    {n.type}
                                                </span>
                                                <span className="tma-mykingdom-news-text">
                                                    {n.text}
                                                </span>
                                                {n.at && (
                                                    <span className="tma-mykingdom-news-date">
                                                        {fmtDate(n.at)}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {status.realms.length > 0 && (
                                <div className="tma-mykingdom-section">
                                    <h3 className="tma-mykingdom-section-title">
                                        The Other Powers
                                    </h3>
                                    <div className="tma-mykingdom-inset">
                                        {status.realms.map((r) => (
                                            <div key={r.id} className="tma-mykingdom-row">
                                                <span className="tma-mykingdom-value">
                                                    {r.name}
                                                </span>
                                                <span className="tma-mykingdom-label">
                                                    {r.underSiege
                                                        ? "besieged"
                                                        : r.atWar
                                                          ? "at war"
                                                          : (r.relation ?? "")}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
                <p className="tma-mykingdom-footnote">Every life is a full game.</p>
            </div>
        </div>
    );
}
