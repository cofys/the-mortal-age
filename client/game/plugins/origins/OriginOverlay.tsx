import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
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

interface Background {
    id: string;
    name: string;
    epithet: string;
    lens: string;
}

interface OriginsStatus {
    needsChoice: boolean;
    hasOrigin: boolean;
    hasBackground: boolean;
    hasName: boolean;
    realms: Realm[];
    backgrounds: Background[];
}

type Step = "kingdom" | "background" | "name";

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

/** Validate a name part client-side: letters/apostrophe/hyphen/space, 2-16 chars. */
function cleanNamePart(input: string): string | null {
    let s = input
        .replace(/[^A-Za-z'\- ]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    if (s.length < 2 || s.length > 16) return null;
    if (s.replace(/[^a-z]/g, "").length < 2) return null;
    return s.replace(/(^|[\s'\-])[a-z]/g, (m) => m.toUpperCase());
}

const STEP_TITLES: Record<Step, string> = {
    kingdom: "Where do you call home?",
    background: "What was your life before?",
    name: "Who are you?",
};

export function OriginOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<OriginsStatus | null>(null);
    const [step, setStep] = useState<Step>("kingdom");
    const [selectedRealmId, setSelectedRealmId] = useState<string>("asgarnia");
    const [selectedBgId, setSelectedBgId] = useState<string | null>(null);
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [nameError, setNameError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const pollRef = useRef<number | undefined>(undefined);
    // Last step implied by the server's progress flags. The poll must only move
    // the step when this CHANGES (initial load or real server-side progress) —
    // never every poll, or it would snap the user back to kingdom mid-flow.
    const lastServerStep = useRef<Step | null>(null);

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
                setSubmitting(false);
                lastServerStep.current = null;
            } else {
                // Jump to the first incomplete step — but only when the
                // server's progress actually changed. The unified claim sets
                // nothing server-side until the final submit, so an
                // unconditional setStep("kingdom") here would yank the user
                // back from background/name on every 2s poll.
                let serverStep: Step;
                if (!data.hasOrigin) serverStep = "kingdom";
                else if (!data.hasBackground) serverStep = "background";
                else serverStep = "name";
                if (serverStep !== lastServerStep.current) {
                    lastServerStep.current = serverStep;
                    setStep(serverStep);
                }
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

    const handleBegin = useCallback(async () => {
        if (submitting) return;
        const first = cleanNamePart(firstName);
        const last = cleanNamePart(lastName);
        if (!first || !last) {
            setNameError("That name won't do — letters only, 2 to 16 characters each.");
            return;
        }
        if (!selectedBgId) {
            setNameError("Choose a past first.");
            setStep("background");
            return;
        }
        setNameError(null);
        setSubmitting(true);
        try {
            // Single unified claim: origin + background + names.
            const params = new URLSearchParams({
                player: username,
                origin: selectedRealmId,
                background: selectedBgId,
                firstname: first,
                lastname: last,
            });
            await fetchContent(`/api/origins-status?${params.toString()}`);
        } catch {
            // Fall through to poll; if the claim landed, needsChoice flips false.
        }
        window.setTimeout(poll, 1500);
    }, [submitting, firstName, lastName, selectedBgId, selectedRealmId, username, poll]);

    if (!status?.needsChoice || !status.realms.length) {
        return null;
    }

    const selectedRealm =
        status.realms.find((r) => r.id === selectedRealmId) ?? status.realms[0];
    const selectedBg =
        status.backgrounds.find((b) => b.id === selectedBgId) ?? null;

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

                {/* Step indicator */}
                <div className="tma-origin-steps" aria-hidden="true">
                    {(["kingdom", "background", "name"] as Step[]).map((s, i) => (
                        <span
                            key={s}
                            className={`tma-origin-step${step === s ? " active" : ""}${
                                ["kingdom", "background", "name"].indexOf(step) > i ? " done" : ""
                            }`}
                        >
                            {i + 1}
                        </span>
                    ))}
                </div>

                <div className="tma-origin-step-title">{STEP_TITLES[step]}</div>

                {step === "kingdom" && (
                    <>
                        <div className="tma-origin-realms">
                            {status.realms.map((realm) => {
                                const isSelected = realm.id === selectedRealm.id;
                                return (
                                    <button
                                        key={realm.id}
                                        className={`tma-origin-realm${isSelected ? " selected" : ""}`}
                                        onClick={() => setSelectedRealmId(realm.id)}
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
                                {selectedRealm.name} — {selectedRealm.epithet}
                            </div>
                            <p className="tma-origin-detail-lens">{selectedRealm.lens}</p>
                        </div>

                        <button
                            className="tma-origin-claim"
                            onClick={() => setStep("background")}
                        >
                            CONTINUE →
                        </button>
                    </>
                )}

                {step === "background" && (
                    <>
                        <div className="tma-origin-realms">
                            {status.backgrounds.map((bg) => {
                                const isSelected = bg.id === selectedBgId;
                                return (
                                    <button
                                        key={bg.id}
                                        className={`tma-origin-realm${isSelected ? " selected" : ""}`}
                                        onClick={() => setSelectedBgId(bg.id)}
                                    >
                                        <span className="tma-origin-realm-text">
                                            <span className="tma-origin-realm-name">{bg.name}</span>
                                            <span className="tma-origin-realm-sub">{bg.epithet}</span>
                                        </span>
                                        <span className="tma-origin-chevron" aria-hidden="true">
                                            ›
                                        </span>
                                    </button>
                                );
                            })}
                        </div>

                        {selectedBg && (
                            <div className="tma-origin-detail">
                                <div className="tma-origin-detail-title">
                                    {selectedBg.name} — {selectedBg.epithet}
                                </div>
                                <p className="tma-origin-detail-lens">{selectedBg.lens}</p>
                            </div>
                        )}

                        <div className="tma-origin-nav">
                            <button
                                className="tma-origin-back"
                                onClick={() => setStep("kingdom")}
                            >
                                ← BACK
                            </button>
                            <button
                                className="tma-origin-claim tma-origin-claim-half"
                                onClick={() => selectedBgId && setStep("name")}
                                disabled={!selectedBgId}
                            >
                                CONTINUE →
                            </button>
                        </div>
                    </>
                )}

                {step === "name" && (
                    <>
                        <div className="tma-origin-name-fields">
                            <label className="tma-origin-name-label">
                                First name
                                <input
                                    className="tma-origin-name-input"
                                    type="text"
                                    value={firstName}
                                    onChange={(e) => setFirstName(e.target.value)}
                                    maxLength={16}
                                    placeholder="Aldric"
                                    autoComplete="off"
                                />
                            </label>
                            <label className="tma-origin-name-label">
                                Family name
                                <input
                                    className="tma-origin-name-input"
                                    type="text"
                                    value={lastName}
                                    onChange={(e) => setLastName(e.target.value)}
                                    maxLength={16}
                                    placeholder="Stonehand"
                                    autoComplete="off"
                                />
                            </label>
                        </div>
                        {nameError && <p className="tma-origin-name-error">{nameError}</p>}
                        <p className="tma-origin-name-hint">
                            {selectedBg
                                ? `A ${selectedBg.name.toLowerCase()} of ${selectedRealm.name}. `
                                : ""}
                            From this day, this is who the world will know.
                        </p>

                        <div className="tma-origin-nav">
                            <button
                                className="tma-origin-back"
                                onClick={() => setStep("background")}
                            >
                                ← BACK
                            </button>
                            <button
                                className="tma-origin-claim tma-origin-claim-half"
                                onClick={handleBegin}
                                disabled={submitting}
                            >
                                {submitting ? "…" : "BEGIN YOUR LIFE"}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
