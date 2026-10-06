import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import { sendChat } from "../../../network/serverConnection/outgoing/inventoryChat";
import "./OriginOverlay.css";

interface Realm {
    id: string;
    name: string;
    city: string;
    demonym: string;
    epithet: string;
    lens: string;
    welcome: string;
}

interface OriginsStatus {
    needsChoice: boolean;
    realms: Realm[];
}

/** Heraldic SVG icons for the six realms — Jon's mockup iconography. */
function RealmIcon({ id }: { id: string }): JSX.Element {
    const common = {
        width: 28,
        height: 28,
        viewBox: "0 0 28 28",
        fill: "none" as const,
    };
    switch (id) {
        case "asgarnia": // banner
            return (
                <svg {...common}>
                    <path d="M8 2h12v24l-6-4.5L8 26V2z" fill="#8a2b2b" stroke="#c9a227" strokeWidth="1.5" />
                    <path d="M14 6v10M11 9l3-2 3 2" stroke="#c9a227" strokeWidth="1.2" />
                </svg>
            );
        case "misthalin": // crown — the heirless crown
            return (
                <svg {...common}>
                    <path d="M5 20l-2-11 6 4 5-7 5 7 6-4-2 11H5z" fill="#c9a227" opacity="0.9" />
                    <rect x="5" y="20" width="18" height="3" fill="#8a6d1f" />
                    <circle cx="14" cy="10" r="1.5" fill="#14100b" />
                </svg>
            );
        case "kandarin": // tree
            return (
                <svg {...common}>
                    <path d="M14 3l6 9h-4l5 8H7l5-8H8l6-9z" fill="#3d6b35" stroke="#c9a227" strokeWidth="1" />
                    <rect x="12.5" y="20" width="3" height="5" fill="#5a3d22" />
                </svg>
            );
        case "morytania": // star — the pale star over Darkmeyer
            return (
                <svg {...common}>
                    <path d="M14 2l2.6 7.4L24 10l-6 5 1.8 8L14 18l-5.8 5L10 15 4 10l7.4-.6L14 2z" fill="#b8c4d4" opacity="0.85" />
                </svg>
            );
        case "keldagrim": // shield — the mountain's forges
            return (
                <svg {...common}>
                    <path d="M14 2l9 4v8c0 6-4 9-9 12-5-3-9-6-9-12V6l9-4z" fill="#8a6d1f" stroke="#c9a227" strokeWidth="1.5" />
                    <path d="M14 7v12M9 10l5 4 5-4" stroke="#14100b" strokeWidth="1.2" />
                </svg>
            );
        case "wanderer": // paw — the road
        default:
            return (
                <svg {...common}>
                    <ellipse cx="14" cy="17" rx="5" ry="4" fill="#8a6d4a" />
                    <circle cx="8" cy="11" r="2.2" fill="#8a6d4a" />
                    <circle cx="14" cy="9" r="2.2" fill="#8a6d4a" />
                    <circle cx="20" cy="11" r="2.2" fill="#8a6d4a" />
                </svg>
            );
    }
}

function claimLabel(realm: Realm): string {
    return realm.id === "wanderer"
        ? "I TAKE TO THE ROAD"
        : `I CLAIM ${realm.name.toUpperCase()} AS MY HOME`;
}

export function OriginOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<OriginsStatus | null>(null);
    const [selectedId, setSelectedId] = useState<string>("asgarnia");
    const [claiming, setClaiming] = useState(false);
    const pollRef = useRef<number | undefined>(undefined);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/origins-status?player=${encodeURIComponent(username)}`
            )) as OriginsStatus;
            setStatus(data);
            if (!data.needsChoice) {
                setClaiming(false);
            }
        } catch {
            // Server unreachable or endpoint missing — stay hidden, retry next poll.
        }
    }, [username, osrsClient]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 2000);
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const handleClaim = useCallback(() => {
        if (claiming) return;
        setClaiming(true);
        try {
            // Programmatic command — the player never types this. The server's
            // existing ::origin claim handler does the real work.
            sendChat(`::origin claim ${selectedId}`);
        } catch {
            setClaiming(false);
        }
        // Re-poll soon: a successful claim flips needsChoice to false.
        window.setTimeout(poll, 1500);
    }, [claiming, selectedId, poll]);

    if (!status?.needsChoice || !status.realms.length) {
        return null;
    }

    const selected = status.realms.find((r) => r.id === selectedId) ?? status.realms[0];

    return (
        <div className="tma-origin-backdrop">
            <div className="tma-origin-panel">
                <div className="tma-origin-compass" aria-hidden="true">
                    <svg width="36" height="36" viewBox="0 0 36 36">
                        <path d="M18 2l4 12 12 4-12 4-4 12-4-12-12-4 12-4 4-12z" fill="#c9a227" />
                        <circle cx="18" cy="18" r="3" fill="#14100b" />
                    </svg>
                </div>

                <p className="tma-origin-header">
                    The gods are silent. The great powers are stirring. Every traveller is asked the same
                    question.
                </p>
                <div className="tma-origin-header-rule" />

                <div className="tma-origin-realms">
                    {status.realms.map((realm) => {
                        const isSelected = realm.id === selected.id;
                        return (
                            <button
                                key={realm.id}
                                className={`tma-origin-realm${isSelected ? " selected" : ""}`}
                                onClick={() => setSelectedId(realm.id)}
                            >
                                <span className="tma-origin-icon">
                                    <RealmIcon id={realm.id} />
                                </span>
                                <span className="tma-origin-realm-text">
                                    <span className="tma-origin-realm-name">{realm.name}</span>
                                    <span className="tma-origin-realm-sub">
                                        {realm.city} · {realm.epithet}
                                    </span>
                                </span>
                                <span className="tma-origin-chevron" aria-hidden="true">
                                    ›
                                </span>
                            </button>
                        );
                    })}
                </div>

                <div className="tma-origin-detail">
                    <div className="tma-origin-detail-title">
                        {selected.name} — {selected.epithet}
                    </div>
                    <p className="tma-origin-detail-lens">{selected.lens}</p>
                </div>

                <button
                    className="tma-origin-claim"
                    onClick={handleClaim}
                    disabled={claiming}
                >
                    {claiming ? "…" : claimLabel(selected)}
                </button>
            </div>
        </div>
    );
}
