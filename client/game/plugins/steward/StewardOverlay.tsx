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

interface StewardStatus {
    open: boolean;
    kingdom?: { id: string; name: string } | null;
    offices?: StewardOffice[];
    held?: StewardHeld[];
    influence?: StewardInfluence;
    ok?: boolean;
}

type View = "menu" | "offices" | "petition" | "standing" | "resign";

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
        async (action: string, extra = "") => {
            setNotice(null);
            try {
                await fetchContent(
                    `/api/steward-status?player=${encodeURIComponent(
                        username
                    )}&action=${action}${extra}`
                );
            } catch {
                // Action failed silently; the chatbox may still show the ruling.
            }
            window.setTimeout(poll, 500);
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
    const offices = status.offices ?? [];
    const held = status.held ?? [];
    const influence = status.influence ?? null;

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

    const renderMenu = () => (
        <div className="tma-steward-menu">
            <button className="tma-steward-action" onClick={() => setView("offices")}>
                <span className="tma-steward-action-title">What offices are open?</span>
                <span className="tma-steward-action-sub">See the seals of the court</span>
            </button>
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
                </div>

                <p className="tma-steward-footnote">The court hears all who kneel.</p>
            </div>
        </div>
    );
}
