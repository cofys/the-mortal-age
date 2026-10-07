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
    appearance: AppearanceChoice | null;
}

interface AppearanceChoice {
    gender: number; // 0 male, 1 female
    head: number; // hair style kit id
    beard: number; // facial hair kit id (-1 = none)
    hairColor: number;
    torsoColor: number;
    legColor: number;
    feetColor: number;
    skinColor: number;
}

type Step = "kingdom" | "background" | "name" | "appearance";

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
    appearance: "How does the world see you?",
};

const STEP_ORDER: Step[] = ["kingdom", "background", "name", "appearance"];

/* ------------------------------------------------------------------ */
/* Appearance — Makeover-style customization for the creation flow.    */
/* ------------------------------------------------------------------ */

/** Approximate OSRS palette hexes for the live 2D preview. */
const SKIN_HEX = ["#e8b98a", "#d9a06f", "#c68855", "#a96f42", "#8a5a34", "#6e4526", "#54331c"];
const HAIR_HEX = [
    "#1a1a1a", "#2e2e2e", "#4a4a4a", "#6b6b6b", "#8c8c8c", "#a8a8a8",
    "#5a3a22", "#6e4a2a", "#8a5f36", "#a8763f", "#c08a48", "#d9a45b",
    "#7a2a1a", "#8f3a22", "#a84a2a", "#c05a30",
    "#d9d9d9", "#e8e8e8", "#f5f5f5", "#ffffff",
    "#3a5a7a", "#4a7a5a", "#7a4a7a", "#5a5a8a",
];
const CLOTH_HEX = [
    "#c0392b", "#e74c3c", "#d35400", "#e67e22", "#f39c12", "#f1c40f",
    "#27ae60", "#2ecc71", "#16a085", "#1abc9c", "#2980b9", "#3498db",
    "#8e44ad", "#9b59b6", "#2c3e50", "#34495e", "#7f8c8d", "#95a5a5",
    "#5d4037", "#795548", "#a1887f", "#d7ccc8", "#212121", "#616161",
    "#0d47a1", "#1b5e20", "#4a148c", "#3e2723",
];
const FEET_HEX = ["#3e2723", "#5d4037", "#795548", "#212121", "#616161", "#0d47a1"];

const MALE_HEADS = [0, 1, 2, 3, 4, 5, 6, 7];
const FEMALE_HEADS = [45, 46, 47, 48, 49, 50, 51, 52];
const MALE_BEARDS = [-1, 10, 11, 12, 13, 14, 15, 16, 17];

const HAIR_NAMES = ["Shaven", "Cropped", "Short", "Side-part", "Swept", "Wild", "Long", "Topknot"];
const BEARD_NAMES = ["Clean", "Stubble", "Short beard", "Full beard", "Long beard", "Goatee", "Moustache", "Sideburns", "Braided"];

const DEFAULT_APPEARANCE: AppearanceChoice = {
    gender: 0, head: 3, beard: 14,
    hairColor: 2, torsoColor: 14, legColor: 5, feetColor: 0, skinColor: 0,
};

/**
 * Stylized 2D character preview. Not the 3D model — a heraldic portrait that
 * updates live as the player changes options.
 */
function CharacterPreview({ app }: { app: AppearanceChoice }): JSX.Element {
    const skin = SKIN_HEX[app.skinColor] ?? SKIN_HEX[0];
    const hair = HAIR_HEX[app.hairColor] ?? HAIR_HEX[2];
    const shirt = CLOTH_HEX[app.torsoColor] ?? CLOTH_HEX[14];
    const pants = CLOTH_HEX[app.legColor] ?? CLOTH_HEX[5];
    const shoes = FEET_HEX[app.feetColor] ?? FEET_HEX[0];
    const female = app.gender === 1;
    const hairIdx = (female ? FEMALE_HEADS : MALE_HEADS).indexOf(app.head);
    const hs = hairIdx < 0 ? 3 : hairIdx; // hair style 0-7
    const hasBeard = !female && app.beard >= 0;

    // Hair silhouettes per style index.
    const hairPath = (() => {
        switch (hs) {
            case 0: return null; // shaven
            case 1: return <path d="M38 34 Q40 18 60 18 Q80 18 82 34 Q70 26 60 27 Q50 26 38 34Z" fill={hair} />;
            case 2: return <path d="M36 36 Q36 16 60 16 Q84 16 84 36 L80 34 Q78 24 60 24 Q42 24 40 34Z" fill={hair} />;
            case 3: return <path d="M36 38 Q34 14 60 14 Q86 14 84 38 L78 36 Q76 22 60 22 Q44 22 42 36Z M42 30 Q50 26 58 28" stroke={hair} strokeWidth="3" fill="none" />;
            case 4: return <path d="M36 36 Q38 16 62 16 Q84 18 82 40 Q74 30 60 30 Q46 30 36 36Z" fill={hair} />;
            case 5: return <path d="M34 40 Q30 12 60 12 Q90 12 86 40 L80 34 Q82 22 60 22 Q38 22 40 34Z M50 18 l4 -6 M62 16 l2 -7 M72 20 l5 -4" stroke={hair} strokeWidth="3" fill={hair} />;
            case 6: return <path d="M34 44 Q32 14 60 14 Q88 14 86 44 L82 60 L78 44 Q78 26 60 26 Q42 26 42 44 L38 60 L34 44Z" fill={hair} />;
            case 7: return <><path d="M38 34 Q40 18 60 18 Q80 18 82 34 Q70 26 60 27 Q50 26 38 34Z" fill={hair} /><circle cx="60" cy="12" r="7" fill={hair} /></>;
            default: return null;
        }
    })();

    return (
        <svg viewBox="0 0 120 200" className="tma-origin-preview-svg" aria-label="Character preview">
            {/* legs */}
            <rect x="46" y="128" width="12" height="44" rx="3" fill={pants} />
            <rect x="62" y="128" width="12" height="44" rx="3" fill={pants} />
            {/* shoes */}
            <rect x="43" y="168" width="18" height="12" rx="4" fill={shoes} />
            <rect x="59" y="168" width="18" height="12" rx="4" fill={shoes} />
            {/* torso */}
            <rect x="40" y="78" width="40" height="54" rx="8" fill={shirt} />
            {/* arms */}
            <rect x="28" y="82" width="10" height="44" rx="5" fill={shirt} />
            <rect x="82" y="82" width="10" height="44" rx="5" fill={shirt} />
            <rect x="28" y="118" width="10" height="14" rx="5" fill={skin} />
            <rect x="82" y="118" width="10" height="14" rx="5" fill={skin} />
            {/* neck + head */}
            <rect x="54" y="66" width="12" height="14" fill={skin} />
            <ellipse cx="60" cy="48" rx="22" ry="24" fill={skin} />
            {/* hair */}
            {hairPath}
            {/* beard */}
            {hasBeard && (
                <path d="M42 52 Q60 78 78 52 Q76 70 60 74 Q44 70 42 52Z" fill={hair} opacity="0.95" />
            )}
            {/* eyes */}
            <circle cx="52" cy="48" r="2.4" fill="#14100b" />
            <circle cx="68" cy="48" r="2.4" fill="#14100b" />
            {/* heraldic frame */}
            <rect x="4" y="4" width="112" height="192" rx="6" fill="none" stroke="#6b5a3a" strokeWidth="1.5" opacity="0.6" />
        </svg>
    );
}

/** A row of swatches for picking a color. */
function Swatches({ colors, value, onPick, label }: {
    colors: string[]; value: number; onPick: (i: number) => void; label: string;
}): JSX.Element {
    return (
        <div className="tma-origin-opt-row">
            <span className="tma-origin-opt-label">{label}</span>
            <div className="tma-origin-swatches">
                {colors.map((c, i) => (
                    <button
                        key={i}
                        className={`tma-origin-swatch${i === value ? " selected" : ""}`}
                        style={{ background: c }}
                        onClick={() => onPick(i)}
                        aria-label={`${label} ${i + 1}`}
                    />
                ))}
            </div>
        </div>
    );
}

/** Prev/next stepper for kit choices (hair style, beard). */
function Stepper({ value, options, names, onPick, label }: {
    value: number; options: number[]; names: string[];
    onPick: (kit: number) => void; label: string;
}): JSX.Element {
    const idx = Math.max(0, options.indexOf(value));
    const step = (d: number) => {
        const n = (idx + d + options.length) % options.length;
        onPick(options[n]);
    };
    return (
        <div className="tma-origin-opt-row">
            <span className="tma-origin-opt-label">{label}</span>
            <div className="tma-origin-stepper">
                <button className="tma-origin-step-btn" onClick={() => step(-1)}>‹</button>
                <span className="tma-origin-step-name">{names[idx] ?? `Style ${idx + 1}`}</span>
                <button className="tma-origin-step-btn" onClick={() => step(1)}>›</button>
            </div>
        </div>
    );
}

export function OriginOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<OriginsStatus | null>(null);
    const [step, setStep] = useState<Step>("kingdom");
    const [selectedRealmId, setSelectedRealmId] = useState<string>("asgarnia");
    const [selectedBgId, setSelectedBgId] = useState<string | null>(null);
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [nameError, setNameError] = useState<string | null>(null);
    const [appearance, setAppearance] = useState<AppearanceChoice>(DEFAULT_APPEARANCE);
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
                // Seed the appearance editor from the server's current look
                // (e.g. after a reset or a partial claim) — once, not on
                // every poll, so the player's in-progress edits aren't wiped.
                if (data.appearance && lastServerStep.current === null) {
                    setAppearance({ ...DEFAULT_APPEARANCE, ...data.appearance });
                }
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
        // Names are valid — move on to the appearance step. The actual claim
        // happens from there via handleFinalBegin.
        setStep("appearance");
    }, [submitting, firstName, lastName, selectedBgId]);

    const setGender = useCallback((gender: number) => {
        setAppearance((a) => {
            const heads = gender === 1 ? FEMALE_HEADS : MALE_HEADS;
            const head = heads.includes(a.head) ? a.head : heads[3];
            return { ...a, gender, head, beard: gender === 1 ? -1 : a.beard };
        });
    }, []);

    const handleFinalBegin = useCallback(async () => {
        if (submitting) return;
        const first = cleanNamePart(firstName);
        const last = cleanNamePart(lastName);
        if (!first || !last || !selectedBgId) {
            setStep("name");
            return;
        }
        setNameError(null);
        setSubmitting(true);
        try {
            // Single unified claim: origin + background + names + appearance.
            const params = new URLSearchParams({
                player: username,
                origin: selectedRealmId,
                background: selectedBgId,
                firstname: first,
                lastname: last,
                appearance: JSON.stringify(appearance),
            });
            const res = (await fetchContent(
                `/api/origins-status?${params.toString()}`
            )) as OriginsStatus & { claimError?: string };
            // The server returns the claim failure reason (if any) so the
            // player sees it instead of nothing happening on click.
            if (res.claimError) {
                setNameError(res.claimError);
                setStep("name");
            }
        } catch {
            // The claim may still have landed server-side; the poll below
            // will close the overlay if needsChoice flipped. If it failed,
            // reset so the player can retry instead of sticking on "…".
            setNameError("The claim didn't go through — try again.");
            setStep("name");
        } finally {
            setSubmitting(false);
        }
        window.setTimeout(poll, 1500);
    }, [submitting, firstName, lastName, selectedBgId, selectedRealmId, username, appearance, poll]);

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
                    {STEP_ORDER.map((s, i) => (
                        <span
                            key={s}
                            className={`tma-origin-step${step === s ? " active" : ""}${
                                STEP_ORDER.indexOf(step) > i ? " done" : ""
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
                            >
                                CONTINUE →
                            </button>
                        </div>
                    </>
                )}

                {step === "appearance" && (
                    <>
                        <div className="tma-origin-appearance">
                            <div className="tma-origin-preview">
                                <CharacterPreview app={appearance} />
                            </div>
                            <div className="tma-origin-appearance-opts">
                                <div className="tma-origin-opt-row">
                                    <span className="tma-origin-opt-label">Body</span>
                                    <div className="tma-origin-gender">
                                        <button
                                            className={`tma-origin-gender-btn${appearance.gender === 0 ? " selected" : ""}`}
                                            onClick={() => setGender(0)}
                                        >
                                            ♂ Male
                                        </button>
                                        <button
                                            className={`tma-origin-gender-btn${appearance.gender === 1 ? " selected" : ""}`}
                                            onClick={() => setGender(1)}
                                        >
                                            ♀ Female
                                        </button>
                                    </div>
                                </div>
                                <Stepper
                                    label="Hair style"
                                    value={appearance.head}
                                    options={appearance.gender === 1 ? FEMALE_HEADS : MALE_HEADS}
                                    names={HAIR_NAMES}
                                    onPick={(head) => setAppearance((a) => ({ ...a, head }))}
                                />
                                {appearance.gender === 0 && (
                                    <Stepper
                                        label="Facial hair"
                                        value={appearance.beard}
                                        options={MALE_BEARDS}
                                        names={BEARD_NAMES}
                                        onPick={(beard) => setAppearance((a) => ({ ...a, beard }))}
                                    />
                                )}
                                <Swatches
                                    label="Skin"
                                    colors={SKIN_HEX}
                                    value={appearance.skinColor}
                                    onPick={(skinColor) => setAppearance((a) => ({ ...a, skinColor }))}
                                />
                                <Swatches
                                    label="Hair"
                                    colors={HAIR_HEX}
                                    value={appearance.hairColor}
                                    onPick={(hairColor) => setAppearance((a) => ({ ...a, hairColor }))}
                                />
                                <Swatches
                                    label="Top"
                                    colors={CLOTH_HEX}
                                    value={appearance.torsoColor}
                                    onPick={(torsoColor) => setAppearance((a) => ({ ...a, torsoColor }))}
                                />
                                <Swatches
                                    label="Legs"
                                    colors={CLOTH_HEX}
                                    value={appearance.legColor}
                                    onPick={(legColor) => setAppearance((a) => ({ ...a, legColor }))}
                                />
                                <Swatches
                                    label="Boots"
                                    colors={FEET_HEX}
                                    value={appearance.feetColor}
                                    onPick={(feetColor) => setAppearance((a) => ({ ...a, feetColor }))}
                                />
                            </div>
                        </div>
                        {nameError && <p className="tma-origin-name-error">{nameError}</p>}

                        <div className="tma-origin-nav">
                            <button
                                className="tma-origin-back"
                                onClick={() => setStep("name")}
                            >
                                ← BACK
                            </button>
                            <button
                                className="tma-origin-claim tma-origin-claim-half"
                                onClick={handleFinalBegin}
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
