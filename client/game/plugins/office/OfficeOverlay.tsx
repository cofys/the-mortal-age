import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./OfficeOverlay.css";

// --- payload types ----------------------------------------------------------

interface PetitionInfo {
    id: string;
    text: string;
    cost: number;
}

interface SupplyOrderInfo {
    units: number;
    pricePer: number;
    by: string | null;
}

interface PatrolOrderInfo {
    target: string;
    targetName: string;
    guards: number;
}

interface NeighborInfo {
    id: string;
    name: string;
}

interface RumorInfo {
    text: string;
}

interface CityInfo {
    id: string;
    name: string;
    capital: string;
}

interface StewardData {
    kind: "steward";
    treasury: number;
    grantCap: number;
    taxRate: number;
    lastTax: number;
    lastWages: number;
    atWar: boolean;
    warLevy: number | null;
    petitions: PetitionInfo[];
}

interface QuartermasterData {
    kind: "quartermaster";
    stockpile: number;
    targetPeace: number;
    targetWar: number;
    wartime: boolean;
    supplyOrder: SupplyOrderInfo | null;
}

interface MarshalData {
    kind: "marshal";
    garrison: number;
    treasury: number;
    patrolOrder: PatrolOrderInfo | null;
    warLevy: number;
    atWar: boolean;
    neighbors: NeighborInfo[];
}

interface SpymasterData {
    kind: "spymaster";
    rumors: RumorInfo[];
    plantCost: number;
    suppressCost: number;
    cities: CityInfo[];
    templates: number[];
}

type OfficeData = StewardData | QuartermasterData | MarshalData | SpymasterData;

interface HeldOffice {
    officeId: string;
    office: string;
    title: string;
    kingdomId: string;
    kingdomName: string;
    holderSince: number | null;
    data: OfficeData;
}

interface VacantOffice {
    officeId: string;
    office: string;
    title: string;
    description: string;
    kingdomId: string;
    kingdomName: string;
}

interface ActionResult {
    ok: boolean;
    message: string;
    reason?: string;
}

interface OfficeStatus {
    open: boolean;
    heldOffices?: HeldOffice[];
    vacantOffices?: VacantOffice[];
    actionResult?: ActionResult;
}

// --- helpers ----------------------------------------------------------------

function coins(n: number): string {
    return Math.floor(n).toLocaleString("en-US");
}

const TAX_RATE_OPTIONS = [0.5, 1, 1.5, 2];
const TAX_RATE_LABELS: Record<number, string> = {
    0.5: "Halve the levy (0.5x)",
    1: "Customary rate (1x)",
    1.5: "Heavy hand (1.5x)",
    2: "War footing (2x)",
};
const WAR_LEVY_OPTIONS = [1.2, 1.6, 2.0, 2.5];
const PEACE_TARGETS = [200, 400, 600];
const WAR_TARGETS = [800, 1200, 1600];
const PATROL_GUARDS = [4, 8, 12];
const SUPPLY_BUNDLES = [
    { units: 100, pricePer: 2 },
    { units: 250, pricePer: 2 },
    { units: 500, pricePer: 3 },
];
const RUMOR_TEMPLATE_LABELS = [
    "Sellswords sharpen blades",
    "Granaries half-empty",
    "Walls will hold",
    "Councillor sells secrets",
];

// --- per-office panels ------------------------------------------------------

function StewardPanel({
    office,
    onAction,
    busy,
}: {
    office: HeldOffice;
    onAction: (params: string) => void;
    busy: boolean;
}) {
    const data = office.data as StewardData;
    const [grantTo, setGrantTo] = useState("");
    const [grantAmount, setGrantAmount] = useState("");
    const grantReady = grantTo.trim().length > 0 && Math.floor(Number(grantAmount)) > 0;
    return (
        <>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Treasury survey</h3>
                <div className="tma-office-inset">
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Treasury</span>
                        <span className="tma-office-row-value gold">{coins(data.treasury)}c</span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Tax rate</span>
                        <span className="tma-office-row-value">{data.taxRate}x</span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Last tax collected</span>
                        <span className="tma-office-row-value">{coins(data.lastTax)}c</span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Last wages paid</span>
                        <span className="tma-office-row-value">{coins(data.lastWages)}c</span>
                    </div>
                    {data.atWar && data.warLevy !== null && (
                        <div className="tma-office-row">
                            <span className="tma-office-row-label">War levy</span>
                            <span className="tma-office-row-value">{data.warLevy}x</span>
                        </div>
                    )}
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Set the tax levy</h3>
                <div className="tma-office-btn-row">
                    {TAX_RATE_OPTIONS.map((rate) => (
                        <button
                            key={rate}
                            className="tma-office-btn"
                            disabled={busy || rate === data.taxRate}
                            onClick={() =>
                                onAction(
                                    `action=set-tax-rate&officeId=${encodeURIComponent(office.officeId)}&rate=${rate}`
                                )
                            }
                        >
                            {TAX_RATE_LABELS[rate]}
                        </button>
                    ))}
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Grant from the treasury</h3>
                <div className="tma-office-inset">
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Available</span>
                        <span className="tma-office-row-value gold">{coins(data.treasury)}c</span>
                    </div>
                    <p className="tma-office-row-label" style={{ margin: "6px 0" }}>
                        Single grants are capped at {coins(data.grantCap)}c. The ledgers are watched —
                        no grants to yourself.
                    </p>
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                        <input
                            placeholder="Player name"
                            value={grantTo}
                            onChange={(e) => setGrantTo(e.target.value)}
                            disabled={busy}
                            style={{ flex: "2 1 0", minWidth: 0, padding: "8px", fontSize: "14px" }}
                        />
                        <input
                            placeholder="Coins"
                            inputMode="numeric"
                            value={grantAmount}
                            onChange={(e) => setGrantAmount(e.target.value.replace(/[^0-9]/g, ""))}
                            disabled={busy}
                            style={{ flex: "1 1 0", minWidth: 0, padding: "8px", fontSize: "14px" }}
                        />
                        <button
                            className="tma-office-btn"
                            style={{ width: "auto", margin: 0, padding: "8px 16px", flex: "0 0 auto" }}
                            disabled={busy || !grantReady}
                            onClick={() => {
                                onAction(
                                    `action=grant-treasury&officeId=${encodeURIComponent(office.officeId)}&to=${encodeURIComponent(grantTo.trim())}&amount=${encodeURIComponent(grantAmount.trim())}`
                                );
                                setGrantTo("");
                                setGrantAmount("");
                            }}
                        >
                            Grant
                        </button>
                    </div>
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">
                    Petitions before the steward ({data.petitions.length})
                </h3>
                <div className="tma-office-inset">
                    {data.petitions.length === 0 && (
                        <p className="tma-office-empty">No petitions await. The court is quiet — for now.</p>
                    )}
                    {data.petitions.map((p) => (
                        <div key={p.id} className="tma-office-petition">
                            <p className="tma-office-petition-text">{p.text}</p>
                            <p className="tma-office-petition-terms">
                                {p.cost > 0
                                    ? `Costs ${coins(p.cost)}c`
                                    : p.cost < 0
                                      ? `Pays ${coins(-p.cost)}c into the treasury`
                                      : "Costs nothing"}
                            </p>
                            <div className="tma-office-btn-row">
                                <button
                                    className="tma-office-btn"
                                    disabled={busy}
                                    onClick={() =>
                                        onAction(
                                            `action=approve-petition&officeId=${encodeURIComponent(office.officeId)}&petitionId=${encodeURIComponent(p.id)}`
                                        )
                                    }
                                >
                                    Approve
                                </button>
                                <button
                                    className="tma-office-btn danger"
                                    disabled={busy}
                                    onClick={() =>
                                        onAction(
                                            `action=deny-petition&officeId=${encodeURIComponent(office.officeId)}&petitionId=${encodeURIComponent(p.id)}`
                                        )
                                    }
                                >
                                    Deny
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

function QuartermasterPanel({
    office,
    onAction,
    busy,
}: {
    office: HeldOffice;
    onAction: (params: string) => void;
    busy: boolean;
}) {
    const data = office.data as QuartermasterData;
    const target = data.wartime ? data.targetWar : data.targetPeace;
    return (
        <>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Stores survey</h3>
                <div className="tma-office-inset">
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Stockpile</span>
                        <span className="tma-office-row-value gold">
                            {coins(data.stockpile)} / {coins(target)} units
                        </span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Peacetime target</span>
                        <span className="tma-office-row-value">{coins(data.targetPeace)} units</span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Wartime target</span>
                        <span className="tma-office-row-value">{coins(data.targetWar)} units</span>
                    </div>
                    {data.supplyOrder ? (
                        <div className="tma-office-row">
                            <span className="tma-office-row-label">Standing order</span>
                            <span className="tma-office-row-value">
                                {coins(data.supplyOrder.units)} units at {data.supplyOrder.pricePer}c each
                            </span>
                        </div>
                    ) : (
                        <div className="tma-office-row">
                            <span className="tma-office-row-label">Standing order</span>
                            <span className="tma-office-row-value">None — the merchants wait.</span>
                        </div>
                    )}
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Stockpile targets</h3>
                <div className="tma-office-btn-row">
                    {PEACE_TARGETS.map((t) => (
                        <button
                            key={t}
                            className="tma-office-btn"
                            disabled={busy || t === data.targetPeace}
                            onClick={() =>
                                onAction(
                                    `action=set-target-peace&officeId=${encodeURIComponent(office.officeId)}&value=${t}`
                                )
                            }
                        >
                            Peace {t}
                        </button>
                    ))}
                </div>
                <div className="tma-office-btn-row">
                    {WAR_TARGETS.map((t) => (
                        <button
                            key={t}
                            className="tma-office-btn"
                            disabled={busy || t === data.targetWar}
                            onClick={() =>
                                onAction(
                                    `action=set-target-war&officeId=${encodeURIComponent(office.officeId)}&value=${t}`
                                )
                            }
                        >
                            War {t}
                        </button>
                    ))}
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Supply order</h3>
                {SUPPLY_BUNDLES.map((b) => (
                    <button
                        key={`${b.units}-${b.pricePer}`}
                        className="tma-office-btn"
                        disabled={busy}
                        onClick={() =>
                            onAction(
                                `action=issue-supply-order&officeId=${encodeURIComponent(office.officeId)}&units=${b.units}&price=${b.pricePer}`
                            )
                        }
                    >
                        Seek {coins(b.units)} units at {b.pricePer}c each ({coins(b.units * b.pricePer)}c when
                        filled)
                    </button>
                ))}
                {data.supplyOrder && (
                    <button
                        className="tma-office-btn danger"
                        disabled={busy}
                        onClick={() =>
                            onAction(
                                `action=cancel-supply-order&officeId=${encodeURIComponent(office.officeId)}`
                            )
                        }
                    >
                        Cancel the standing order
                    </button>
                )}
            </div>
        </>
    );
}

function MarshalPanel({
    office,
    onAction,
    busy,
}: {
    office: HeldOffice;
    onAction: (params: string) => void;
    busy: boolean;
}) {
    const data = office.data as MarshalData;
    const [patrolTarget, setPatrolTarget] = useState("home");
    return (
        <>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Garrison review</h3>
                <div className="tma-office-inset">
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Garrison</span>
                        <span className="tma-office-row-value gold">{data.garrison}/60 blades</span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Treasury</span>
                        <span className="tma-office-row-value">{coins(data.treasury)}c</span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">Standing patrol</span>
                        <span className="tma-office-row-value">
                            {data.patrolOrder
                                ? `${data.patrolOrder.guards} guards on ${data.patrolOrder.targetName} (${coins(data.patrolOrder.guards * 25)}c/tick)`
                                : "None — the roads are watched only by habit."}
                        </span>
                    </div>
                    <div className="tma-office-row">
                        <span className="tma-office-row-label">War levy</span>
                        <span className="tma-office-row-value">{data.warLevy}x</span>
                    </div>
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">Order patrols</h3>
                <div className="tma-office-btn-row">
                    <button
                        className={`tma-office-btn ${patrolTarget === "home" ? "active" : ""}`}
                        disabled={busy}
                        onClick={() => setPatrolTarget("home")}
                    >
                        Home roads
                    </button>
                    {data.neighbors.map((n) => (
                        <button
                            key={n.id}
                            className={`tma-office-btn ${patrolTarget === n.id ? "active" : ""}`}
                            disabled={busy}
                            onClick={() => setPatrolTarget(n.id)}
                        >
                            {n.name}
                        </button>
                    ))}
                </div>
                <div className="tma-office-btn-row">
                    {PATROL_GUARDS.map((guards) => (
                        <button
                            key={guards}
                            className="tma-office-btn"
                            disabled={busy}
                            onClick={() =>
                                onAction(
                                    `action=set-patrol&officeId=${encodeURIComponent(office.officeId)}&target=${encodeURIComponent(patrolTarget)}&guards=${guards}`
                                )
                            }
                        >
                            {guards} guards ({coins(guards * 25)}c/tick)
                        </button>
                    ))}
                </div>
                {data.patrolOrder && (
                    <button
                        className="tma-office-btn danger"
                        disabled={busy}
                        onClick={() =>
                            onAction(
                                `action=clear-patrol&officeId=${encodeURIComponent(office.officeId)}`
                            )
                        }
                    >
                        Stand the patrols down
                    </button>
                )}
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">War levy</h3>
                <div className="tma-office-btn-row">
                    {WAR_LEVY_OPTIONS.map((levy) => (
                        <button
                            key={levy}
                            className="tma-office-btn"
                            disabled={busy || levy === data.warLevy}
                            onClick={() =>
                                onAction(
                                    `action=set-war-levy&officeId=${encodeURIComponent(office.officeId)}&levy=${levy}`
                                )
                            }
                        >
                            {levy}x
                        </button>
                    ))}
                </div>
            </div>
        </>
    );
}

function SpymasterPanel({
    office,
    onAction,
    busy,
}: {
    office: HeldOffice;
    onAction: (params: string) => void;
    busy: boolean;
}) {
    const data = office.data as SpymasterData;
    const [rumorCity, setRumorCity] = useState(data.cities[0]?.id ?? "");
    const [rumorTemplate, setRumorTemplate] = useState(0);
    return (
        <>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">
                    What circulates ({data.rumors.length})
                </h3>
                <div className="tma-office-inset">
                    {data.rumors.length === 0 && (
                        <p className="tma-office-empty">The streets are quiet. Too quiet.</p>
                    )}
                    {data.rumors.slice(-6).map((r, i) => (
                        <div key={i} className="tma-office-row">
                            <span className="tma-office-row-value" style={{ textAlign: "left" }}>
                                “{r.text}”
                            </span>
                            <button
                                className="tma-office-btn danger"
                                style={{ width: "auto", margin: 0, padding: "4px 10px", fontSize: 12 }}
                                disabled={busy}
                                onClick={() =>
                                    onAction(
                                        `action=suppress-rumor&officeId=${encodeURIComponent(office.officeId)}&index=${i}`
                                    )
                                }
                                title={`Bury this whisper (${coins(data.suppressCost)}c)`}
                            >
                                Bury
                            </button>
                        </div>
                    ))}
                </div>
            </div>
            <div className="tma-office-section">
                <h3 className="tma-office-section-title">
                    Plant a rumor ({coins(data.plantCost)}c)
                </h3>
                <div className="tma-office-btn-row">
                    {data.cities.map((c) => (
                        <button
                            key={c.id}
                            className={`tma-office-btn ${rumorCity === c.id ? "active" : ""}`}
                            disabled={busy}
                            onClick={() => setRumorCity(c.id)}
                        >
                            {c.capital}
                        </button>
                    ))}
                </div>
                <div className="tma-office-btn-row">
                    {data.templates.map((t) => (
                        <button
                            key={t}
                            className={`tma-office-btn ${rumorTemplate === t ? "active" : ""}`}
                            disabled={busy}
                            onClick={() => setRumorTemplate(t)}
                        >
                            {RUMOR_TEMPLATE_LABELS[t] ?? `Whisper ${t + 1}`}
                        </button>
                    ))}
                </div>
                <button
                    className="tma-office-btn"
                    disabled={busy || !rumorCity}
                    onClick={() =>
                        onAction(
                            `action=plant-rumor&officeId=${encodeURIComponent(office.officeId)}&target=${encodeURIComponent(rumorCity)}&template=${rumorTemplate}`
                        )
                    }
                >
                    Plant the whisper
                </button>
            </div>
        </>
    );
}

// --- main overlay -----------------------------------------------------------

export function OfficeOverlay({ osrsClient }: { osrsClient: OsrsClient }) {
    const [status, setStatus] = useState<OfficeStatus | null>(null);
    const [activeTab, setActiveTab] = useState(0);
    const [busy, setBusy] = useState(false);
    const pollRef = useRef<number | undefined>(undefined);
    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(
                `/api/office-status?player=${encodeURIComponent(username)}`
            )) as OfficeStatus;
            setStatus(data);
            setBusy(false);
        } catch {
            // Stay hidden, retry next poll. Never throw in the poll loop.
        }
    }, [username, osrsClient]);

    const doAction = useCallback(
        async (params: string) => {
            if (!username || busy) return;
            setBusy(true);
            try {
                const data = (await fetchContent(
                    `/api/office-status?player=${encodeURIComponent(username)}&${params}`
                )) as OfficeStatus;
                setStatus(data);
                if (data.actionResult) {
                    window.setTimeout(poll, 400);
                }
            } catch {
                // Next poll refreshes.
            } finally {
                setBusy(false);
            }
        },
        [username, busy, poll]
    );

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 2000); // 2s poll — heavier payload
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const handleClose = useCallback(async () => {
        setStatus(null);
        try {
            await fetchContent(
                `/api/office-status?player=${encodeURIComponent(username)}&action=close`
            );
        } catch {
            /* next poll sees open:false anyway */
        }
        window.setTimeout(poll, 500);
    }, [username, poll]);

    if (!status?.open) return null;

    const held = status.heldOffices ?? [];
    const vacant = status.vacantOffices ?? [];
    const active = held[Math.min(activeTab, Math.max(0, held.length - 1))];

    return (
        <div className="tma-office-backdrop" onClick={handleClose}>
            <div className="tma-office-panel" onClick={(e) => e.stopPropagation()}>
                <button className="tma-office-close" onClick={handleClose} aria-label="Close">
                    ✕
                </button>
                <p className="tma-office-kicker">Seals of office</p>
                <h2 className="tma-office-name">The War Table — Your Seals</h2>
                <div className="tma-office-header-rule" />
                {status.actionResult && (
                    <p className={`tma-office-result ${status.actionResult.ok ? "ok" : "fail"}`}>
                        {status.actionResult.message}
                    </p>
                )}
                {held.length > 0 && (
                    <div className="tma-office-tabs">
                        {held.map((o, i) => (
                            <button
                                key={o.officeId}
                                className={`tma-office-tab ${i === activeTab ? "active" : ""}`}
                                onClick={() => setActiveTab(i)}
                            >
                                {o.title} — {o.kingdomName}
                            </button>
                        ))}
                    </div>
                )}
                <div className="tma-office-scroll">
                    {held.length === 0 && (
                        <div className="tma-office-empty">
                            <p>You hold no seals of office.</p>
                            <p>
                                Vacant offices are petitioned for before the court — the realm rewards the
                                ambitious.
                            </p>
                        </div>
                    )}
                    {active && active.data.kind === "steward" && (
                        <StewardPanel office={active} onAction={doAction} busy={busy} />
                    )}
                    {active && active.data.kind === "quartermaster" && (
                        <QuartermasterPanel office={active} onAction={doAction} busy={busy} />
                    )}
                    {active && active.data.kind === "marshal" && (
                        <MarshalPanel office={active} onAction={doAction} busy={busy} />
                    )}
                    {active && active.data.kind === "spymaster" && (
                        <SpymasterPanel office={active} onAction={doAction} busy={busy} />
                    )}
                    {active && (
                        <div className="tma-office-section">
                            <button
                                className="tma-office-btn danger"
                                disabled={busy}
                                onClick={() =>
                                    doAction(
                                        `action=vacate-office&officeId=${encodeURIComponent(active.officeId)}`
                                    )
                                }
                            >
                                Lay down the {active.title} seals
                            </button>
                        </div>
                    )}
                    {vacant.length > 0 && (
                        <div className="tma-office-section">
                            <h3 className="tma-office-section-title">Vacant offices — petition the court</h3>
                            <div className="tma-office-inset">
                                {vacant.map((v) => (
                                    <div key={v.officeId} className="tma-office-row">
                                        <span className="tma-office-row-value" style={{ textAlign: "left" }}>
                                            {v.title} — {v.kingdomName}
                                            <br />
                                            <span className="tma-office-row-label">{v.description}</span>
                                        </span>
                                        <button
                                            className="tma-office-btn"
                                            style={{ width: "auto", margin: 0, padding: "6px 12px" }}
                                            disabled={busy}
                                            onClick={() =>
                                                doAction(
                                                    `action=petition-office&officeId=${encodeURIComponent(v.officeId)}`
                                                )
                                            }
                                        >
                                            Petition
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <p className="tma-office-footnote">Every life is a full game.</p>
            </div>
        </div>
    );
}
