import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./StewardOverlay.css";

interface StewardOffice {
    officeId: string;
    title: string;
    vacant: boolean;
    holderName: string | null;
}

interface StewardHeld {
    officeId: string;
    title: string;
}

interface StewardInfluence {
    value: number;
    petitionThreshold: number;
    challengeThreshold: number;
    trial: { progress: number; target: number; daysLeft: number } | null;
}

interface NaturalizationQuest {
    kingdomId: string;
    kingdomName: string;
    startedAt: number | null;
    influence: number;
    target: number;
    fee: number;
    feeCarried: number;
    cooldownDaysLeft: number;
    oathReady: boolean;
    blockers: string[];
}

interface StewardStatus {
    open: boolean;
    kingdom?: { id: string; name: string } | null;
    allegiance?: { id: string; name: string } | null;
    offices?: StewardOffice[];
    held?: StewardHeld[];
    influence?: StewardInfluence;
    naturalization?: NaturalizationQuest | null;
    ok?: boolean;
    message?: string;
}

type View = "menu" | "offices" | "petition" | "standing" | "resign" | "renounce" | "join";

export function StewardOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<StewardStatus | null>(null);
    const [view, setView] = useState<View>("menu");
    const [confirmVacate, setConfirmVacate] = useState<string | null>(null);
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
                `/api/steward-status?player=${encodeURIComponent(username)}`
            )) as StewardStatus;
            setStatus(data);
            if (!data.open) {
                setView("menu");
                setConfirmVacate(null);
            }
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

    const act = useCallback(
        async (action: string, extra = ""): Promise<StewardStatus | null> => {
            setNotice(null);
            try {
                const res = (await fetchContent(
                    `/api/steward-status?player=${encodeURIComponent(
                        username
                    )}&action=${action}${extra}`
                )) as StewardStatus;
                window.setTimeout(poll, 500);
                return res;
            } catch {
                // Action failed silently; the chatbox may still show the ruling.
                window.setTimeout(poll, 500);
                return null;
            }
        },
        [username, poll]
    );

    const close = useCallback(() => {
        setStatus(null);
        setView("menu");
        act("close");
    }, [act]);

    if (!status?.open) {
        return null;
    }

    const kingdom = status.kingdom ?? null;
    const allegiance = status.allegiance ?? null;
    const offices = status.offices ?? [];
    const held = status.held ?? [];
    const influence = status.influence ?? null;
    const naturalization = status.naturalization ?? null;

    const servesThisCourt = !!allegiance && !!kingdom && allegiance.id === kingdom.id;
    const servesAnotherCourt = !!allegiance && !!kingdom && allegiance.id !== kingdom.id;
    const servesNone = !allegiance;

    const doPetition = (officeId: string) => {
        act("petition", `&office=${encodeURIComponent(officeId)}`);
        setNotice("Your petition is heard. Watch the chatbox for the court's ruling.");
    };

    const doVacate = (officeId: string) => {
        act("vacate", `&office=${encodeURIComponent(officeId)}`);
        setConfirmVacate(null);
        setView("menu");
        setNotice("The seals are laid down. The court will name another.");
    };

    const doRenounce = async () => {
        const res = await act("renounce");
        setView("menu");
        setNotice(
            res?.message ??
                "Your oath is renounced. Seven days must pass before any court will take a new one."
        );
    };

    const doPetitionJoin = async () => {
        const res = await act("petition-join");
        setNotice(
            res?.message ??
                "Your petition is heard. Prove yourself through service to the realm."
        );
    };

    const doTakeOath = async () => {
        const res = await act("take-oath");
        setNotice(
            res?.message ?? "The oath is sworn. Rise, subject of the realm."
        );
    };

    const renderMenu = () => (
        <div className="tma-steward-menu">
            <button className="tma-steward-action" onClick={() => setView("offices")}>
                <span className="tma-steward-action-title">What offices are open?</span>
                <span className="tma-steward-action-sub">See the seals of the court</span>
            </button>
            {servesThisCourt && (
                <>
                    <button className="tma-steward-action" onClick={() => setView("petition")}>
                        <span className="tma-steward-action-title">I wish to petition for an office.</span>
                        <span className="tma-steward-action-sub">Seek the court's favour</span>
                    </button>
                    <button className="tma-steward-action" onClick={() => setView("standing")}>
                        <span className="tma-steward-action-title">How do I stand with the court?</span>
                        <span className="tma-steward-action-sub">Your influence and trials</span>
                    </button>
                    <button className="tma-steward-action" onClick={() => setView("resign")}>
                        <span className="tma-steward-action-title">I resign my office.</span>
                        <span className="tma-steward-action-sub">Lay down your seals</span>
                    </button>
                    <button className="tma-steward-action" onClick={() => setView("renounce")}>
                        <span className="tma-steward-action-title">I renounce my allegiance.</span>
                        <span className="tma-steward-action-sub">Break your oath — at a cost</span>
                    </button>
                </>
            )}
            {servesNone && (
                <>
                    <button className="tma-steward-action" onClick={() => setView("join")}>
                        <span className="tma-steward-action-title">I seek to join this realm.</span>
                        <span className="tma-steward-action-sub">Petition for naturalization</span>
                    </button>
                    <button className="tma-steward-action" onClick={() => setView("standing")}>
                        <span className="tma-steward-action-title">How do I stand with the court?</span>
                        <span className="tma-steward-action-sub">Your influence and trials</span>
                    </button>
                </>
            )}
            {servesAnotherCourt && (
                <div className="tma-steward-inset">
                    <p className="tma-steward-empty">
                        The steward studies you coldly. You already serve{" "}
                        {allegiance?.name ?? "another court"} — renounce your oath at your own
                        court before this one will hear you.
                    </p>
                </div>
            )}
        </div>
    );

    const renderOffices = () => (
        <div>
            <button className="tma-steward-back" onClick={() => setView("menu")}>
                ← Back
            </button>
            <h3 className="tma-steward-section-title">Offices of the Court</h3>
            <div className="tma-steward-inset">
                {offices.length === 0 && (
                    <p className="tma-steward-empty">No offices found.</p>
                )}
                {offices.map((o) => (
                    <div key={o.officeId} className="tma-steward-office-row">
                        <div>
                            <p className="tma-steward-office-title">{o.title}</p>
                            {!o.vacant && o.holderName && (
                                <p className="tma-steward-office-holder">
                                    Held by {o.holderName}
                                </p>
                            )}
                        </div>
                        <span
                            className={
                                o.vacant
                                    ? "tma-steward-badge tma-steward-badge-vacant"
                                    : "tma-steward-badge tma-steward-badge-held"
                            }
                        >
                            {o.vacant ? "Vacant" : "Held"}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderPetition = () => (
        <div>
            <button className="tma-steward-back" onClick={() => setView("menu")}>
                ← Back
            </button>
            <h3 className="tma-steward-section-title">Which seals do you seek?</h3>
            <div className="tma-steward-inset">
                {offices.map((o) => (
                    <div key={o.officeId} className="tma-steward-office-row">
                        <div>
                            <p className="tma-steward-office-title">{o.title}</p>
                            <p className="tma-steward-office-holder">
                                {o.vacant
                                    ? "Vacant — petition to be appointed"
                                    : `Held by ${o.holderName} — petition to challenge`}
                            </p>
                        </div>
                        <button
                            className="tma-steward-small-btn"
                            onClick={() => doPetition(o.officeId)}
                        >
                            {o.vacant ? "Petition" : "Challenge"}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderStanding = () => (
        <div>
            <button className="tma-steward-back" onClick={() => setView("menu")}>
                ← Back
            </button>
            <h3 className="tma-steward-section-title">Your Standing</h3>
            <div className="tma-steward-inset">
                {influence ? (
                    <>
                        <p className="tma-steward-standing-big">
                            {influence.value}{" "}
                            <span className="tma-steward-standing-label">influence</span>
                        </p>
                        <p className="tma-steward-standing-line">
                            Petition threshold: {influence.petitionThreshold}
                        </p>
                        <p className="tma-steward-standing-line">
                            Challenge threshold: {influence.challengeThreshold}
                        </p>
                        {influence.trial && (
                            <p className="tma-steward-standing-line">
                                Trial of service: {influence.trial.progress}/
                                {influence.trial.target} — {influence.trial.daysLeft}{" "}
                                day{influence.trial.daysLeft === 1 ? "" : "s"} remain.
                            </p>
                        )}
                    </>
                ) : (
                    <p className="tma-steward-empty">The court has no measure of you yet.</p>
                )}
            </div>
        </div>
    );

    const renderResign = () => (
        <div>
            <button className="tma-steward-back" onClick={() => setView("menu")}>
                ← Back
            </button>
            <h3 className="tma-steward-section-title">Lay Down Your Seals</h3>
            <div className="tma-steward-inset">
                {held.length === 0 && (
                    <p className="tma-steward-empty">
                        You hold no seals{kingdom ? ` of ${kingdom.name}` : ""}. There is
                        nothing to resign.
                    </p>
                )}
                {held.map((o) => (
                    <div key={o.officeId}>
                        {confirmVacate === o.officeId ? (
                            <div className="tma-steward-confirm">
                                <p className="tma-steward-confirm-text">
                                    Lay down the seals of {o.title}? The court will name
                                    another.
                                </p>
                                <div className="tma-steward-confirm-actions">
                                    <button
                                        className="tma-steward-danger-btn"
                                        onClick={() => doVacate(o.officeId)}
                                    >
                                        Yes. I resign.
                                    </button>
                                    <button
                                        className="tma-steward-small-btn"
                                        onClick={() => setConfirmVacate(null)}
                                    >
                                        Keep them.
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="tma-steward-office-row">
                                <p className="tma-steward-office-title">{o.title}</p>
                                <button
                                    className="tma-steward-small-btn"
                                    onClick={() => setConfirmVacate(o.officeId)}
                                >
                                    Resign
                                </button>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );

    const renderRenounce = () => (
        <div>
            <button className="tma-steward-back" onClick={() => setView("menu")}>
                ← Back
            </button>
            <h3 className="tma-steward-section-title">Renounce Your Allegiance</h3>
            <div className="tma-steward-inset">
                <div className="tma-steward-confirm">
                    <p className="tma-steward-confirm-text">
                        Break your oath to {kingdom ? kingdom.name : "this court"}? Weigh
                        it well:
                    </p>
                    <p className="tma-steward-standing-line">
                        • Your influence with {kingdom ? kingdom.name : "the court"} falls
                        by 75 — into hatred.
                    </p>
                    <p className="tma-steward-standing-line">
                        • Word spreads: each other great power has a chance to hear of
                        your oathbreaking and think less of you.
                    </p>
                    <p className="tma-steward-standing-line">
                        • You lay down any offices you hold, and lose your rank and titles.
                    </p>
                    <p className="tma-steward-standing-line">
                        • Seven days must pass before any court will take a new oath
                        from you.
                    </p>
                    <div className="tma-steward-confirm-actions">
                        <button className="tma-steward-danger-btn" onClick={doRenounce}>
                            I renounce my oath.
                        </button>
                        <button className="tma-steward-small-btn" onClick={() => setView("menu")}>
                            I keep my oath.
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    const renderJoin = () => {
        const quest = naturalization;
        const questHere =
            quest && kingdom && quest.kingdomId === kingdom.id ? quest : null;
        const progressPct = questHere
            ? Math.min(100, Math.max(0, Math.round((questHere.influence / questHere.target) * 100)))
            : 0;
        return (
            <div>
                <button className="tma-steward-back" onClick={() => setView("menu")}>
                    ← Back
                </button>
                <h3 className="tma-steward-section-title">
                    Petition for Naturalization
                </h3>
                <div className="tma-steward-inset">
                    {!quest && (
                        <>
                            <p className="tma-steward-standing-line">
                                The court of {kingdom ? kingdom.name : "this realm"} does
                                not hand citizenship to strangers. Petition, and prove
                                yourself through real service — war-effort donations,
                                supplies, the court's tasks — until your influence
                                reaches the court's measure. A fee is due when you swear.
                            </p>
                            <div className="tma-steward-confirm-actions">
                                <button className="tma-steward-small-btn" onClick={doPetitionJoin}>
                                    Petition the court.
                                </button>
                            </div>
                        </>
                    )}
                    {quest && !questHere && (
                        <>
                            <p className="tma-steward-standing-line">
                                Your petition lies before {quest.kingdomName}, not this
                                court. Petition here instead, and the old petition is
                                withdrawn.
                            </p>
                            <div className="tma-steward-confirm-actions">
                                <button className="tma-steward-small-btn" onClick={doPetitionJoin}>
                                    Petition this court instead.
                                </button>
                            </div>
                        </>
                    )}
                    {questHere && (
                        <>
                            <p className="tma-steward-standing-big">
                                {questHere.influence}{" "}
                                <span className="tma-steward-standing-label">
                                    / {questHere.target} influence
                                </span>
                            </p>
                            <div className="tma-steward-progress-track">
                                <div
                                    className="tma-steward-progress-fill"
                                    style={{ width: `${progressPct}%` }}
                                />
                            </div>
                            <p className="tma-steward-standing-line">
                                Court's fee: {questHere.fee.toLocaleString("en-US")} coins —
                                you carry {questHere.feeCarried.toLocaleString("en-US")}.
                            </p>
                            {questHere.blockers.map((b, i) => (
                                <p key={i} className="tma-steward-standing-line">
                                    • {b}
                                </p>
                            ))}
                            {questHere.oathReady ? (
                                <div className="tma-steward-confirm-actions">
                                    <button className="tma-steward-small-btn" onClick={doTakeOath}>
                                        Kneel and swear the oath.
                                    </button>
                                </div>
                            ) : (
                                <p className="tma-steward-empty">
                                    Serve the realm — donate to its war effort, deliver
                                    its supplies — and return when the court is convinced.
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="tma-steward-backdrop" onClick={close}>
            <div className="tma-steward-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-steward-close" onClick={close} aria-label="Close">
                    ✕
                </button>

                <p className="tma-steward-kicker">The Steward&apos;s Desk</p>
                <h2 className="tma-steward-name">{kingdom ? kingdom.name : "The Court"}</h2>
                <div className="tma-steward-header-rule" />

                <div className="tma-steward-scroll">
                    {notice && <p className="tma-steward-notice">{notice}</p>}
                    {view === "menu" && renderMenu()}
                    {view === "offices" && renderOffices()}
                    {view === "petition" && renderPetition()}
                    {view === "standing" && renderStanding()}
                    {view === "resign" && renderResign()}
                    {view === "renounce" && renderRenounce()}
                    {view === "join" && renderJoin()}
                </div>

                <p className="tma-steward-footnote">The court hears all who kneel.</p>
            </div>
        </div>
    );
}
