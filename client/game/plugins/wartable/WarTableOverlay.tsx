import { useCallback, useEffect, useRef, useState } from "react";

import type { OsrsClient } from "../../OsrsClient";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";
import "./WarTableOverlay.css";

interface KingdomInfo {
    id: string;
    name: string;
    capital: string | null;
    ruler: string | null;
    rulerTitle: string | null;
    treasury: number;
    situation: string | null;
<<<<<<< HEAD
=======
    castle: CastleInfo | null;
    relation: string | null;
    vassalOf: string | null;
    vassalOfName: string | null;
    vassalCount: number;
    underSiege: boolean;
    besiegingCount: number;
    atWar: boolean;
    coalition: CoalitionRef | null;
}

interface CoalitionRef {
    key: string;
    name: string;
}

interface CoalitionMember {
    id: string;
    name: string;
}

interface CoalitionInfo {
    key: string;
    name: string;
    members: CoalitionMember[];
    pactCount: number;
    totalStrength: number;
    formedAt: number | null;
}

interface SuccessionClaimantInfo {
    id: string;
    name: string;
    title: string | null;
    claim: string | null;
    claimLabel: string | null;
    strength: number;
    backers: number;
}

interface SuccessionCrisisInfo {
    id: string;
    kingdomId: string;
    kingdomName: string;
    lateRuler: string | null;
    ticksLeft: number | null;
    claimants: SuccessionClaimantInfo[];
}

interface CivilWarSideInfo {
    name: string;
    title: string | null;
    strength: number;
}

interface CivilWarInfo {
    id: string;
    kingdomId: string;
    kingdomName: string;
    sides: CivilWarSideInfo[];
    ticksLeft: number | null;
    drained: number;
}

interface DefenseCallEntry {
    allyId: string;
    allyName: string;
    status: "deliberating" | "joined" | "absent" | "refused";
}

interface DefenseCallInfo {
    attackerId: string;
    defenderId: string;
    attackerName: string;
    defenderName: string;
    calls: DefenseCallEntry[];
>>>>>>> 8f4c8d6a
}

interface WarInfo {
    attacker: string;
    defender: string;
    attackerName: string;
    defenderName: string;
    reason: string | null;
    declaredAt: number | null;
}

interface EndedWarInfo {
    attackerName: string;
    defenderName: string;
    outcome: string;
    endedAt: number | null;
}

interface AllianceInfo {
    a: string;
    b: string;
    aName: string;
    bName: string;
    pactName: string | null;
    strength: number;
    formedAt: number | null;
}

interface RelationInfo {
    a: string;
    b: string;
    tension: number;
    allied: boolean;
}

interface PlayerKingdom {
    id: string;
    name: string;
    rank: string | null;
}

interface WarTableStatus {
    open: boolean;
    playerKingdom: PlayerKingdom | null;
    kingdoms: KingdomInfo[];
    wars: WarInfo[];
    endedWars: EndedWarInfo[];
    alliances: AllianceInfo[];
    relations: RelationInfo[];
<<<<<<< HEAD
=======
    sieges: SiegeInfo[];
    vassalage: VassalageInfo[];
    coalitions: CoalitionInfo[];
    defenseCalls: DefenseCallInfo[];
    successionCrises: SuccessionCrisisInfo[];
    civilWars: CivilWarInfo[];
    homeDetail: HomeDetail | null;
    actionResult?: ActionResult;
>>>>>>> 8f4c8d6a
}

type TabId = "overview" | "diplomacy" | "military" | "treasury" | "wars";

const TABS: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "diplomacy", label: "Diplomacy" },
    { id: "military", label: "Military" },
    { id: "treasury", label: "Treasury" },
    { id: "wars", label: "Wars" },
];

function fmtCoins(n: number): string {
    return Math.floor(n).toLocaleString("en-US");
}

function fmtDate(ts: number | null): string {
    if (!ts) return "date unknown";
    try {
        return new Date(ts).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    } catch {
        return "date unknown";
    }
}

function tensionTier(t: number): { label: string; color: string } {
    if (t >= 80) return { label: "At the brink", color: "#d43a2a" };
    if (t >= 60) return { label: "Volatile", color: "#b84a3a" };
    if (t >= 40) return { label: "Hostile", color: "#c97b2d" };
    if (t >= 20) return { label: "Wary", color: "#c9a227" };
    return { label: "Calm", color: "#7ba05b" };
}

function relationFor(
    status: WarTableStatus,
    kingdomId: string
): { badge: string; color: string; tension: number } | null {
    const home = status.playerKingdom?.id;
    if (!home || home === kingdomId) return null;
    const rel = status.relations.find(
        (r) =>
            (r.a === home && r.b === kingdomId) || (r.b === home && r.a === kingdomId)
    );
    if (!rel) return null;
    const atWar = status.wars.some(
        (w) =>
            (w.attacker === home && w.defender === kingdomId) ||
            (w.defender === home && w.attacker === kingdomId)
    );
    if (atWar) return { badge: "AT WAR", color: "#d43a2a", tension: rel.tension };
    if (rel.allied) return { badge: "ALLIED", color: "#c9a227", tension: rel.tension };
    const tier = tensionTier(rel.tension);
    return { badge: tier.label.toUpperCase(), color: tier.color, tension: rel.tension };
}

function StrengthPips({ strength }: { strength: number }): JSX.Element {
    const pips = [];
    for (let i = 1; i <= 5; i++) {
        pips.push(
            <span
                key={i}
                className={`tma-wartable-pip${i <= strength ? " lit" : ""}`}
                aria-hidden="true"
            />
        );
    }
    return <span className="tma-wartable-pips">{pips}</span>;
}

function TensionBar({ value }: { value: number }): JSX.Element {
    const tier = tensionTier(value);
    return (
        <span className="tma-wartable-tension">
            <span className="tma-wartable-tension-track">
                <span
                    className="tma-wartable-tension-fill"
                    style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tier.color }}
                />
            </span>
            <span className="tma-wartable-tension-label" style={{ color: tier.color }}>
                {tier.label} · {value}
            </span>
        </span>
    );
}

export function WarTableOverlay({ osrsClient }: { osrsClient: OsrsClient }): JSX.Element | null {
    const [status, setStatus] = useState<WarTableStatus | null>(null);
    const [tab, setTab] = useState<TabId>("overview");
    const [selectedId, setSelectedId] = useState<string | null>(null);
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
                `/api/wartable-status?player=${encodeURIComponent(username)}`
            )) as WarTableStatus;
            setStatus(data);
            if (data.open && !selectedId && data.playerKingdom) {
                setSelectedId(data.playerKingdom.id);
            }
        } catch {
            // Server unreachable or endpoint missing — stay hidden, retry next poll.
        }
    }, [username, osrsClient, selectedId]);

    useEffect(() => {
        poll();
        pollRef.current = window.setInterval(poll, 3000);
        return () => {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
    }, [poll]);

    const close = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            await fetchContent(
                `/api/wartable-status?player=${encodeURIComponent(
                    username
                )}&action=close`
            );
        } catch {
            // Fall through; next poll picks up state.
        }
        window.setTimeout(() => {
            poll();
            setBusy(false);
        }, 600);
    }, [busy, username, poll]);

    if (!status?.open) return null;

    const home = status.playerKingdom;
    const kingdomsById = new Map(status.kingdoms.map((k) => [k.id, k]));
    const selected = kingdomsById.get(selectedId ?? "") ?? kingdomsById.get(home?.id ?? "") ?? status.kingdoms[0];
    const maxTreasury = Math.max(1, ...status.kingdoms.map((k) => k.treasury));

    const warsFor = (id: string) =>
        status.wars.filter((w) => w.attacker === id || w.defender === id);
    const alliancesFor = (id: string) =>
        status.alliances.filter((a) => a.a === id || a.b === id);

    return (
        <div className="tma-wartable-backdrop">
            <div className="tma-wartable-panel">
                <button
                    className="tma-wartable-close"
                    onClick={close}
                    disabled={busy}
                    aria-label="Close war table"
                >
                    ✕
                </button>

                <div className="tma-wartable-compass" aria-hidden="true">
                    <svg width="40" height="40" viewBox="0 0 40 40">
                        <path d="M20 2l4.5 13.5L38 20l-13.5 4.5L20 38l-4.5-13.5L2 20l13.5-4.5L20 2z" fill="#c9a227" />
                        <circle cx="20" cy="20" r="3.5" fill="#14100b" />
                    </svg>
                </div>

                <h1 className="tma-wartable-title">WAR TABLE</h1>
                <p className="tma-wartable-subtitle">
                    The realm at a glance, writ on the campaign map.
                </p>
                <div className="tma-wartable-rule" />

                <div className="tma-wartable-tabs" role="tablist">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            role="tab"
                            aria-selected={tab === t.id}
                            className={`tma-wartable-tab${tab === t.id ? " active" : ""}`}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                <div className="tma-wartable-body">
                    {tab === "overview" && (
                        <div className="tma-wartable-overview">
                            <div className="tma-wartable-powers">
                                {status.kingdoms.map((k) => {
                                    const rel = relationFor(status, k.id);
                                    const isHome = home?.id === k.id;
                                    const isSel = selected?.id === k.id;
                                    return (
                                        <button
                                            key={k.id}
                                            className={`tma-wartable-power${isSel ? " selected" : ""}${isHome ? " home" : ""}`}
                                            onClick={() => setSelectedId(k.id)}
                                        >
                                            <span className="tma-wartable-power-name">
                                                {k.name}
                                                {isHome && <span className="tma-wartable-home-tag"> · HOME</span>}
                                            </span>
                                            <span className="tma-wartable-power-sub">
                                                {k.capital ?? "No capital"}
                                            </span>
                                            {rel && (
                                                <span
                                                    className="tma-wartable-badge"
                                                    style={{ borderColor: rel.color, color: rel.color }}
                                                >
                                                    {rel.badge}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            {selected && (
                                <div className="tma-wartable-detail">
                                    <div className="tma-wartable-detail-title">
                                        {selected.name}
                                        {home?.id === selected.id && home.rank && (
                                            <span className="tma-wartable-rank"> — {home.rank}</span>
                                        )}
                                    </div>
                                    {selected.ruler && (
                                        <div className="tma-wartable-detail-ruler">
                                            {selected.ruler}
                                            {selected.rulerTitle && (
                                                <span className="tma-wartable-detail-rulertitle">
                                                    {" "}· {selected.rulerTitle}
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    {selected.situation && (
                                        <p className="tma-wartable-detail-text">{selected.situation}</p>
                                    )}
                                    <div className="tma-wartable-detail-stats">
                                        <div className="tma-wartable-stat">
                                            <span className="tma-wartable-stat-label">War chest</span>
                                            <span className="tma-wartable-stat-value">
                                                {fmtCoins(selected.treasury)} gp
                                            </span>
                                        </div>
                                        <div className="tma-wartable-stat">
                                            <span className="tma-wartable-stat-label">Open wars</span>
                                            <span className="tma-wartable-stat-value">
                                                {warsFor(selected.id).length}
                                            </span>
                                        </div>
                                        <div className="tma-wartable-stat">
                                            <span className="tma-wartable-stat-label">Pacts</span>
                                            <span className="tma-wartable-stat-value">
                                                {alliancesFor(selected.id).length}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

<<<<<<< HEAD
=======
                    {tab === "realm" && (
                        <div className="tma-wartable-section">
                            <h2 className="tma-wartable-section-title">Fealty of the Realm</h2>
                            {(status.vassalage ?? []).length === 0 ? (
                                <p className="tma-wartable-empty">
                                    No oaths sworn — every crown answers to none.
                                </p>
                            ) : (
                                <div className="tma-wartable-cards">
                                    {status.kingdoms
                                        .filter((k) => (k.vassalCount ?? 0) > 0)
                                        .map((k) => (
                                            <div key={k.id} className="tma-wartable-card">
                                                <div className="tma-wartable-card-title">
                                                    👑 {k.name}
                                                    <span className="tma-wartable-muted">
                                                        {" "}· overlord of {(k.vassalCount ?? 0)}
                                                    </span>
                                                </div>
                                                {(status.vassalage ?? [])
                                                    .filter((v) => v.overlordId === k.id)
                                                    .map((v) => (
                                                        <div key={v.vassalId} className="tma-wartable-vassal-row">
                                                            <span className="tma-wartable-vassal-indent">↳</span>
                                                            <span>{v.vassalName}</span>
                                                            <span className="tma-wartable-muted">
                                                                {" "}· sworn{v.since ? ` ${fmtDate(v.since)}` : ""}
                                                            </span>
                                                        </div>
                                                    ))}
                                            </div>
                                        ))}
                                </div>
                            )}
                            <h2 className="tma-wartable-section-title">Coalitions of the Realm</h2>
                            {(status.coalitions ?? []).length === 0 ? (
                                <p className="tma-wartable-empty">
                                    No leagues formed — pacts stand alone, for now.
                                </p>
                            ) : (
                                <div className="tma-wartable-cards">
                                    {(status.coalitions ?? []).map((c) => (
                                        <div key={c.key} className="tma-wartable-card">
                                            <div className="tma-wartable-card-title">
                                                🤝 {c.name}
                                            </div>
                                            <div className="tma-wartable-card-sub">
                                                {c.members.map((m) => m.name).join(" · ")}
                                            </div>
                                            <div className="tma-wartable-card-row">
                                                <span className="tma-wartable-muted">
                                                    {c.pactCount} pact{c.pactCount === 1 ? "" : "s"}
                                                </span>
                                                <StrengthPips strength={Math.min(5, Math.max(1, Math.round(c.totalStrength / Math.max(1, c.pactCount))))} />
                                            </div>
                                            {c.formedAt && (
                                                <div className="tma-wartable-card-sub">
                                                    Rose {fmtDate(c.formedAt)}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                            <h2 className="tma-wartable-section-title">Thrones in Dispute</h2>
                            {(status.successionCrises ?? []).length === 0 &&
                            (status.civilWars ?? []).length === 0 ? (
                                <p className="tma-wartable-empty">
                                    Every crown sits secure — for now.
                                </p>
                            ) : (
                                <div className="tma-wartable-cards">
                                    {(status.successionCrises ?? []).map((c) => {
                                        const total = c.claimants.reduce((s, cl) => s + cl.strength, 0);
                                        return (
                                            <div key={c.id} className="tma-wartable-card">
                                                <div className="tma-wartable-card-title">
                                                    👑 {c.kingdomName} — succession crisis
                                                </div>
                                                <div className="tma-wartable-card-sub">
                                                    {c.lateRuler ? `After ${c.lateRuler}. ` : ""}
                                                    The court is split:
                                                </div>
                                                {(c.claimants ?? []).map((cl) => (
                                                    <div key={cl.id} className="tma-wartable-card-row">
                                                        <span>
                                                            {cl.name}
                                                            <span className="tma-wartable-muted">
                                                                {" "}· {cl.claimLabel ?? cl.claim}
                                                                {cl.title ? ` · ${cl.title}` : ""}
                                                            </span>
                                                        </span>
                                                        <span className="tma-wartable-muted">
                                                            {total > 0
                                                                ? Math.round((cl.strength / total) * 100)
                                                                : 0}
                                                            %
                                                        </span>
                                                        <button
                                                            className="tma-wartable-btn"
                                                            onClick={() =>
                                                                runAction(
                                                                    `action=back-claimant&target=${encodeURIComponent(c.kingdomId)}&claimant=${encodeURIComponent(cl.id)}`
                                                                )
                                                            }
                                                        >
                                                            Back ({cl.backers})
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })}
                                    {(status.civilWars ?? []).map((w) => (
                                        <div key={w.id} className="tma-wartable-card">
                                            <div className="tma-wartable-card-title">
                                                ⚔️ {w.kingdomName} — civil war
                                            </div>
                                            {(w.sides ?? []).map((s, i) => (
                                                <div key={i} className="tma-wartable-card-row">
                                                    <span>
                                                        {s.name}
                                                        {s.title ? (
                                                            <span className="tma-wartable-muted">
                                                                {" "}· {s.title}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <StrengthPips strength={Math.min(5, Math.max(1, Math.round(s.strength / 20)))} />
                                                </div>
                                            ))}
                                            <div className="tma-wartable-card-sub">
                                                {fmtCoins(w.drained)} coins burned in the fighting.
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <h2 className="tma-wartable-section-title">Battle Lines</h2>
                            <div className="tma-wartable-cards">
                                {status.kingdoms.map((k) => {
                                    const badges: { text: string; color: string }[] = [];
                                    if (k.atWar) badges.push({ text: "⚔ AT WAR", color: "#d43a2a" });
                                    if (k.underSiege) badges.push({ text: "🏰 UNDER SIEGE", color: "#c97b2d" });
                                    if ((k.besiegingCount ?? 0) > 0)
                                        badges.push({
                                            text: `⚒ BESIEGING ${k.besiegingCount}`,
                                            color: "#c9a227",
                                        });
                                    return (
                                        <div key={k.id} className="tma-wartable-card">
                                            <div className="tma-wartable-card-title">
                                                {k.name}
                                                {home?.id === k.id && (
                                                    <span className="tma-wartable-home-tag"> · HOME</span>
                                                )}
                                            </div>
                                            {k.coalition && (
                                                <div className="tma-wartable-card-sub">
                                                    🤝 {k.coalition.name}
                                                </div>
                                            )}
                                            {k.vassalOfName && (
                                                <div className="tma-wartable-card-sub">
                                                    Sworn to {k.vassalOfName}
                                                </div>
                                            )}
                                            {(k.vassalCount ?? 0) > 0 && !k.vassalOfName && (
                                                <div className="tma-wartable-card-sub">
                                                    Overlord of {k.vassalCount} vassal{k.vassalCount === 1 ? "" : "s"}
                                                </div>
                                            )}
                                            {badges.length === 0 ? (
                                                <div className="tma-wartable-card-row">
                                                    <span className="tma-wartable-muted">At peace</span>
                                                </div>
                                            ) : (
                                                <div className="tma-wartable-card-row tma-wartable-badges">
                                                    {badges.map((b, i) => (
                                                        <span
                                                            key={i}
                                                            className="tma-wartable-badge"
                                                            style={{ borderColor: b.color, color: b.color }}
                                                        >
                                                            {b.text}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="tma-wartable-note">
                                Oaths and battle lines, drawn from the realm's own records.
                                The courts move on their own — watch the map change.
                            </p>
                        </div>
                    )}

>>>>>>> 8f4c8d6a
                    {tab === "diplomacy" && (
                        <div className="tma-wartable-section">
                            <h2 className="tma-wartable-section-title">Pacts & Alliances</h2>
                            {status.alliances.length === 0 ? (
                                <p className="tma-wartable-empty">
                                    No pacts sealed — every crown stands alone.
                                </p>
                            ) : (
                                <div className="tma-wartable-cards">
                                    {status.alliances.map((a, i) => (
                                        <div key={`${a.a}-${a.b}-${i}`} className="tma-wartable-card">
                                            <div className="tma-wartable-card-title">
                                                {a.aName} — {a.bName}
                                            </div>
                                            {a.pactName && (
                                                <div className="tma-wartable-card-sub">“{a.pactName}”</div>
                                            )}
                                            <div className="tma-wartable-card-row">
                                                <span className="tma-wartable-muted">Bond strength</span>
                                                <StrengthPips strength={a.strength} />
                                            </div>
                                            {a.formedAt && (
                                                <div className="tma-wartable-card-sub">
                                                    Sealed {fmtDate(a.formedAt)}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                            <h2 className="tma-wartable-section-title">Tensions</h2>
                            <div className="tma-wartable-tension-list">
                                {(home
                                    ? status.relations.filter((r) => r.a === home.id || r.b === home.id)
                                    : status.relations
                                ).map((r) => {
                                    const other = r.a === home?.id ? r.b : r.a;
                                    const otherName = kingdomsById.get(other)?.name ?? other;
                                    return (
                                        <div key={`${r.a}-${r.b}`} className="tma-wartable-tension-row">
                                            <span className="tma-wartable-tension-names">
                                                {home ? (
                                                    <>{home.name} — {otherName}</>
                                                ) : (
                                                    <>{kingdomsById.get(r.a)?.name} — {otherName}</>
                                                )}
                                                {r.allied && (
                                                    <span className="tma-wartable-allied-tag"> allied</span>
                                                )}
                                            </span>
                                            <TensionBar value={r.tension} />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {tab === "military" && (
                        <div className="tma-wartable-section">
                            <h2 className="tma-wartable-section-title">Strength of Arms</h2>
                            <div className="tma-wartable-cards">
                                {status.kingdoms.map((k) => {
                                    const wf = warsFor(k.id);
                                    const af = alliancesFor(k.id);
                                    const support = af.reduce((s, a) => s + (a.strength ?? 1), 0);
                                    return (
                                        <div key={k.id} className="tma-wartable-card">
                                            <div className="tma-wartable-card-title">{k.name}</div>
                                            <div className="tma-wartable-card-row">
                                                <span className="tma-wartable-muted">War chest</span>
                                                <span className="tma-wartable-gold">{fmtCoins(k.treasury)} gp</span>
                                            </div>
                                            <div className="tma-wartable-card-row">
                                                <span className="tma-wartable-muted">Wars fighting</span>
                                                <span className={wf.length ? "tma-wartable-war" : ""}>
                                                    {wf.length === 0
                                                        ? "At peace"
                                                        : wf.map((w) => `vs ${w.attacker === k.id ? w.defenderName : w.attackerName}`).join(", ")}
                                                </span>
                                            </div>
                                            <div className="tma-wartable-card-row">
                                                <span className="tma-wartable-muted">Allied support</span>
                                                <span>
                                                    {af.length === 0 ? "None" : `${af.length} pact${af.length > 1 ? "s" : ""} (bond ${support})`}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="tma-wartable-note">
                                Troop musters and campaign planning arrive with the campaign system —
                                for now the table shows what the crown can pay for and who bleeds beside it.
                            </p>
                        </div>
                    )}

                    {tab === "treasury" && (
                        <div className="tma-wartable-section">
                            <h2 className="tma-wartable-section-title">Coffers of the Realm</h2>
                            {status.kingdoms.map((k) => (
                                <div key={k.id} className="tma-wartable-treasury-row">
                                    <span className="tma-wartable-treasury-name">
                                        {k.name}
                                        {home?.id === k.id && <span className="tma-wartable-home-tag"> · HOME</span>}
                                    </span>
                                    <span className="tma-wartable-treasury-bar">
                                        <span
                                            className="tma-wartable-treasury-fill"
                                            style={{ width: `${(k.treasury / maxTreasury) * 100}%` }}
                                        />
                                    </span>
                                    <span className="tma-wartable-treasury-amt">{fmtCoins(k.treasury)} gp</span>
                                </div>
                            ))}
                            <p className="tma-wartable-note">
                                Taxes, trade and tribute flow into these coffers. Wars drain them.
                                Spend wisely — the Simulation ticks whether you watch or not.
                            </p>
                        </div>
                    )}

                    {tab === "wars" && (
                        <div className="tma-wartable-section">
                            <h2 className="tma-wartable-section-title">Open Wars</h2>
                            {status.wars.length === 0 ? (
                                <p className="tma-wartable-empty">
                                    No open wars — an uneasy peace.
                                </p>
                            ) : (
                                <div className="tma-wartable-cards">
                                    {status.wars.map((w, i) => (
                                        <div key={`${w.attacker}-${w.defender}-${i}`} className="tma-wartable-card tma-wartable-war-card">
                                            <div className="tma-wartable-card-title tma-wartable-war">
                                                {w.attackerName} ⚔ {w.defenderName}
                                            </div>
                                            {w.reason && (
                                                <p className="tma-wartable-detail-text">{w.reason}</p>
                                            )}
                                            <div className="tma-wartable-card-sub">
                                                Declared {fmtDate(w.declaredAt)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {status.endedWars.length > 0 && (
                                <>
                                    <h2 className="tma-wartable-section-title">Settled Conflicts</h2>
                                    <div className="tma-wartable-history">
                                        {status.endedWars.map((w, i) => (
                                            <div key={i} className="tma-wartable-history-row">
                                                <span>
                                                    {w.attackerName} vs {w.defenderName}
                                                </span>
                                                <span className="tma-wartable-muted">
                                                    {w.outcome} · {fmtDate(w.endedAt)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                <p className="tma-wartable-footnote">
                    Study often — crowns move while you sleep.
                </p>
            </div>
        </div>
    );
}
