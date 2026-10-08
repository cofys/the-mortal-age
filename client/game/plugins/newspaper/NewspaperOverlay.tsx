import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./NewspaperOverlay.css";

interface NewspaperData {
    id: string;
    kingdom: string;
    paper: string;
    compiledAt: number;
    headlines: string[];
    gossip: string[];
    announcements: string[];
    obituaries: string[];
}

interface NewspaperStatus {
    open: boolean;
    paper?: NewspaperData;
}

function weekLabel(compiledAt: number): string {
    try {
        const d = new Date(compiledAt);
        return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch {
        return "";
    }
}

export function NewspaperOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const [status, setStatus] = useState<NewspaperStatus | null>(null);
    const pollRef = useRef<number | undefined>(undefined);
    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/newspaper-status?player=${encodeURIComponent(username)}`
            )) as NewspaperStatus;
            setStatus(data);
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

    const handleClose = useCallback(async () => {
        setStatus(null);
        try {
            await fetchContent(
                `/api/newspaper-status?player=${encodeURIComponent(username)}&action=close`
            );
        } catch {
            // The next poll will see open:false anyway once the flag clears.
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    if (!status?.open || !status.paper) {
        return null;
    }

    const paper = status.paper;

    return (
        <div className="tma-newspaper-backdrop" onClick={handleClose}>
            <div className="tma-newspaper-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-newspaper-close" onClick={handleClose} aria-label="Close">
                    ✕
                </button>
                <p className="tma-newspaper-kicker">The town crier presents</p>
                <h2 className="tma-newspaper-name">{paper.paper}</h2>
                <p className="tma-newspaper-edition">Week of {weekLabel(paper.compiledAt)}</p>
                <div className="tma-newspaper-header-rule" />
                <div className="tma-newspaper-scroll">
                    <div className="tma-newspaper-section">
                        <h3 className="tma-newspaper-section-title">Headlines</h3>
                        <div className="tma-newspaper-inset">
                            {paper.headlines.map((h, i) => (
                                <p key={i} className="tma-newspaper-headline">
                                    {h}
                                </p>
                            ))}
                        </div>
                    </div>

                    {paper.gossip.length > 0 && (
                        <div className="tma-newspaper-section">
                            <h3 className="tma-newspaper-section-title">The Gossip Column</h3>
                            <div className="tma-newspaper-inset">
                                {paper.gossip.map((g, i) => (
                                    <p key={i} className="tma-newspaper-gossip">
                                        {g}
                                    </p>
                                ))}
                            </div>
                        </div>
                    )}

                    {paper.announcements.length > 0 && (
                        <div className="tma-newspaper-section">
                            <h3 className="tma-newspaper-section-title">Announcements</h3>
                            <div className="tma-newspaper-inset">
                                {paper.announcements.map((a, i) => (
                                    <p key={i} className="tma-newspaper-announcement">
                                        {a}
                                    </p>
                                ))}
                            </div>
                        </div>
                    )}

                    {paper.obituaries.length > 0 && (
                        <div className="tma-newspaper-section">
                            <h3 className="tma-newspaper-section-title">Obituaries</h3>
                            <div className="tma-newspaper-inset">
                                {paper.obituaries.map((o, i) => (
                                    <p key={i} className="tma-newspaper-obituary">
                                        {o}
                                    </p>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <p className="tma-newspaper-footnote">Every life is a full game.</p>
            </div>
        </div>
    );
}
