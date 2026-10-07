import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./ExamineOverlay.css";

interface ReputationEntry {
    kingdom: string;
    tier: string;
    points: number;
}

interface GuildInfo {
    name: string;
    rank: string;
}

interface SkillInfo {
    name: string;
    level: number;
}

interface CharacterSheet {
    name: string;
    byline: string | null;
    description: string | null;
    reputation: ReputationEntry[];
    accomplishments: string[];
    accomplishmentCount: number;
    guild: GuildInfo | null;
    skills: SkillInfo[];
}

interface ExamineStatus {
    open: boolean;
    sheet?: CharacterSheet;
}

const TIER_COLORS: Record<string, string> = {
    Revered: "#ffd27f",
    Respected: "#d9b45b",
    Known: "#e8ded0",
    Noticed: "#9a8f7d",
    Neutral: "#9a8f7d",
};

function tierColor(tier: string): string {
    return TIER_COLORS[tier] ?? "#9a8f7d";
}

export function ExamineOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<ExamineStatus | null>(null);
    const pollRef = useRef<number | undefined>(undefined);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/examine-status?player=${encodeURIComponent(username)}`
            )) as ExamineStatus;
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
                `/api/examine-status?player=${encodeURIComponent(username)}&action=close`
            );
        } catch {
            // The next poll will see open:false anyway once the flag clears.
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    if (!status?.open || !status.sheet) {
        return null;
    }

    const sheet = status.sheet;

    return (
        <div className="tma-examine-backdrop" onClick={handleClose}>
            <div className="tma-examine-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-examine-close" onClick={handleClose} aria-label="Close">
                    ✕
                </button>

                <p className="tma-examine-kicker">Character Sheet</p>
                <h2 className="tma-examine-name">{sheet.name}</h2>
                {sheet.byline && <p className="tma-examine-byline">{sheet.byline}</p>}
                <div className="tma-examine-header-rule" />

                <div className="tma-examine-scroll">
                    <section className="tma-examine-section">
                        <h3 className="tma-examine-section-title">The Person</h3>
                        <div className="tma-examine-inset">
                            {sheet.description ? (
                                <p className="tma-examine-description">{sheet.description}</p>
                            ) : (
                                <p className="tma-examine-empty">
                                    No description set. Use ::desc to tell your story.
                                </p>
                            )}
                        </div>
                    </section>

                    <section className="tma-examine-section">
                        <h3 className="tma-examine-section-title">Reputation</h3>
                        <div className="tma-examine-inset">
                            {sheet.reputation.length > 0 ? (
                                sheet.reputation.map((r) => (
                                    <div key={r.kingdom} className="tma-examine-rep-row">
                                        <span className="tma-examine-rep-kingdom">{r.kingdom}</span>
                                        <span
                                            className="tma-examine-rep-tier"
                                            style={{ color: tierColor(r.tier) }}
                                        >
                                            {r.tier}
                                        </span>
                                        <span className="tma-examine-rep-points">({r.points})</span>
                                    </div>
                                ))
                            ) : (
                                <p className="tma-examine-empty">
                                    No standing yet — serve a kingdom to earn a name.
                                </p>
                            )}
                        </div>
                    </section>

                    <section className="tma-examine-section">
                        <h3 className="tma-examine-section-title">Deeds & Honours</h3>
                        <div className="tma-examine-inset">
                            {sheet.accomplishments.length > 0 ? (
                                <>
                                    {sheet.accomplishments.map((q) => (
                                        <p key={q} className="tma-examine-deed">
                                            <span className="tma-examine-deed-bullet">◆</span> {q}
                                        </p>
                                    ))}
                                    {sheet.accomplishmentCount > sheet.accomplishments.length && (
                                        <p className="tma-examine-empty">
                                            +{sheet.accomplishmentCount - sheet.accomplishments.length} more
                                        </p>
                                    )}
                                </>
                            ) : (
                                <p className="tma-examine-empty">
                                    No deeds yet. The realm is waiting.
                                </p>
                            )}
                        </div>
                    </section>

                    <div className="tma-examine-columns">
                        <section className="tma-examine-section">
                            <h3 className="tma-examine-section-title">Allegiance</h3>
                            <div className="tma-examine-inset">
                                {sheet.guild ? (
                                    <>
                                        <p className="tma-examine-guild-name">{sheet.guild.name}</p>
                                        <p className="tma-examine-guild-rank">{sheet.guild.rank}</p>
                                    </>
                                ) : (
                                    <p className="tma-examine-empty">Sworn to none — a free agent.</p>
                                )}
                            </div>
                        </section>

                        <section className="tma-examine-section">
                            <h3 className="tma-examine-section-title">Notable Skills</h3>
                            <div className="tma-examine-inset">
                                {sheet.skills.length > 0 ? (
                                    sheet.skills.map((s) => (
                                        <div key={s.name} className="tma-examine-skill-row">
                                            <span className="tma-examine-skill-name">{s.name}</span>
                                            <span className="tma-examine-skill-level">{s.level}</span>
                                        </div>
                                    ))
                                ) : (
                                    <p className="tma-examine-empty">No notable skills yet.</p>
                                )}
                            </div>
                        </section>
                    </div>
                </div>

                <p className="tma-examine-footnote">Every life is a full game.</p>
            </div>
        </div>
    );
}
