import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./OnboardingOverlay.css";

interface OnboardingStep {
    title: string;
    text: string;
}

interface OnboardingKingdom {
    name: string;
    capital: string | null;
}

interface OnboardingStatus {
    open: boolean;
    kingdom?: OnboardingKingdom | null;
    steps?: OnboardingStep[];
    world?: string[];
}

export function OnboardingOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<OnboardingStatus | null>(null);
    const pollRef = useRef<number | undefined>(undefined);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/onboarding-status?player=${encodeURIComponent(username)}`
            )) as OnboardingStatus;
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

    const dismiss = useCallback(
        async (action: "close" | "dontshow") => {
            setStatus(null);
            try {
                await fetchContent(
                    `/api/onboarding-status?player=${encodeURIComponent(
                        username
                    )}&action=${action}`
                );
            } catch {
                // The next poll will see open:false anyway once the flag clears.
            }
            window.setTimeout(poll, 500);
        },
        [username, poll]
    );

    const handleClose = useCallback(() => dismiss("close"), [dismiss]);
    const handleDontShow = useCallback(() => dismiss("dontshow"), [dismiss]);

    if (!status?.open) {
        return null;
    }

    const kingdom = status.kingdom ?? null;
    const steps = status.steps ?? [];
    const world = status.world ?? [];

    return (
        <div className="tma-onboarding-backdrop" onClick={handleClose}>
            <div className="tma-onboarding-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-onboarding-close" onClick={handleClose} aria-label="Close">
                    ✕
                </button>

                <p className="tma-onboarding-kicker">Welcome to The Mortal Age</p>
                <h2 className="tma-onboarding-name">Your First Ten Minutes</h2>
                <div className="tma-onboarding-header-rule" />

                <div className="tma-onboarding-scroll">
                    <section className="tma-onboarding-section">
                        <h3 className="tma-onboarding-section-title">Where You Are</h3>
                        <div className="tma-onboarding-inset">
                            {kingdom ? (
                                <p className="tma-onboarding-where">
                                    You stand in{" "}
                                    <span className="tma-onboarding-where-name">{kingdom.name}</span>
                                    {kingdom.capital && (
                                        <>
                                            {" — "}your capital is{" "}
                                            <span className="tma-onboarding-where-name">
                                                {kingdom.capital}
                                            </span>
                                        </>
                                    )}
                                    .
                                </p>
                            ) : (
                                <p className="tma-onboarding-empty">
                                    You have sworn to no kingdom yet. Wander, explore — a crown will
                                    find you, or you will find one.
                                </p>
                            )}
                        </div>
                    </section>

                    <section className="tma-onboarding-section">
                        <h3 className="tma-onboarding-section-title">First Steps</h3>
                        <div className="tma-onboarding-inset">
                            {steps.length > 0 ? (
                                steps.map((step, i) => (
                                    <div key={i} className="tma-onboarding-step">
                                        <p className="tma-onboarding-step-title">
                                            <span className="tma-onboarding-step-number">
                                                {i + 1}.
                                            </span>{" "}
                                            {step.title}
                                        </p>
                                        <p className="tma-onboarding-step-text">{step.text}</p>
                                    </div>
                                ))
                            ) : (
                                <p className="tma-onboarding-empty">
                                    Walk. Talk. Look around. The realm is yours to discover.
                                </p>
                            )}
                        </div>
                    </section>

                    <section className="tma-onboarding-section">
                        <h3 className="tma-onboarding-section-title">How This World Works</h3>
                        <div className="tma-onboarding-inset">
                            {world.length > 0 ? (
                                world.map((line, i) => (
                                    <p key={i} className="tma-onboarding-world-line">
                                        <span className="tma-onboarding-world-bullet">◆</span> {line}
                                    </p>
                                ))
                            ) : (
                                <p className="tma-onboarding-empty">
                                    Everything here is player-driven.
                                </p>
                            )}
                        </div>
                    </section>
                </div>

                <div className="tma-onboarding-actions">
                    <button className="tma-onboarding-begin" onClick={handleClose}>
                        Begin
                    </button>
                    <button className="tma-onboarding-dontshow" onClick={handleDontShow}>
                        Don&apos;t show again
                    </button>
                </div>

                <p className="tma-onboarding-footnote">Every life is a full game.</p>
            </div>
        </div>
    );
}
