import { useState } from "react";

import type {
    PeaceOfferInfo,
    WarInfo,
    WarTableStatus,
    WarTableTabId,
} from "./useWarTable";
import "./WarTableOverlay.css";

const TABS: { id: WarTableTabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "realm", label: "Realm" },
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

function supplyColor(pct: number): string {
    if (pct >= 75) return "#7ba05b";
    if (pct >= 50) return "#c9a227";
    if (pct >= 25) return "#c97b2d";
    return "#d43a2a";
}

function SupplyBar({ pct }: { pct: number }): JSX.Element {
    const color = supplyColor(pct);
    return (
        <span className="tma-wartable-tension">
            <span className="tma-wartable-tension-track">
                <span
                    className="tma-wartable-tension-fill"
                    style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
                />
            </span>
        </span>
    );
}

const PEACE_TERM_OPTIONS: { id: string; label: string }[] = [
    { id: "white-peace", label: "White peace" },
    { id: "tribute", label: "Tribute (they pay)" },
    { id: "vassalize", label: "Vassalize them" },
    { id: "nap", label: "Non-aggression pact (14 days)" },
    { id: "trade-rights", label: "Trade rights" },
];

/**
 * One open war, with the actions a belligerent's court can take in it:
 * give battle, offer/accept peace, surrender — and sally/repair when
 * your own walls are under siege. The server enforces every gate; this
 * card only presents them.
 */
function WarCard({
    war,
    homeId,
    pendingOffer,
    homeBesieged,
    busy,
    runAction,
}: {
    war: WarInfo;
    homeId: string | null;
    pendingOffer: PeaceOfferInfo | null;
    homeBesieged: boolean;
    busy: boolean;
    runAction: (params: string) => void;
}): JSX.Element {
    const [terms, setTerms] = useState("white-peace");
    const [tribute, setTribute] = useState("100000");
    const [confirmSurrender, setConfirmSurrender] = useState(false);
    const isBelligerent = homeId !== null && (war.attacker === homeId || war.defender === homeId);
    const otherId = war.attacker === homeId ? war.defender : war.attacker;
    const incomingOffer = pendingOffer && pendingOffer.offeredBy !== homeId ? pendingOffer : null;

    return (
        <div className="tma-wartable-card tma-wartable-war-card">
            <div className="tma-wartable-card-title tma-wartable-war">
                {war.attackerName} ⚔ {war.defenderName}
            </div>
            {war.reason && <p className="tma-wartable-detail-text">{war.reason}</p>}
            <div className="tma-wartable-card-sub">
                {war.goalLabel ? `War of ${war.goalLabel} · ` : ""}Declared {fmtDate(war.declaredAt)}
            </div>
            {war.score && (
                <div className="tma-wartable-card-sub">
                    War score — {war.attackerName} {war.score.attacker} · {war.defenderName}{" "}
                    {war.score.defender}
                </div>
            )}
            {war.battle && (
                <div className="tma-wartable-card-sub">
                    {war.battle.status === "mustering"
                        ? "⚑ A battle gathers at the border field — hosts are mustering."
                        : "⚑ Battle joined at the border field!"}
                </div>
            )}
            {isBelligerent && (
                <>
                    <div className="tma-wartable-card-row">
                        <button
                            className="tma-wartable-btn"
                            disabled={busy || !!war.battle}
                            onClick={() =>
                                runAction(`action=give-battle&target=${encodeURIComponent(otherId)}`)
                            }
                        >
                            Give Battle
                        </button>
                        {homeBesieged && (
                            <>
                                <button
                                    className="tma-wartable-btn"
                                    disabled={busy}
                                    onClick={() => runAction(`action=sally`)}
                                >
                                    Sally Forth
                                </button>
                                <button
                                    className="tma-wartable-btn"
                                    disabled={busy}
                                    onClick={() => runAction(`action=repair`)}
                                >
                                    Repair Walls
                                </button>
                            </>
                        )}
                        {confirmSurrender ? (
                            <>
                                <button
                                    className="tma-wartable-btn"
                                    disabled={busy}
                                    onClick={() =>
                                        runAction(
                                            `action=surrender&target=${encodeURIComponent(otherId)}`
                                        )
                                    }
                                >
                                    Confirm Surrender
                                </button>
                                <button
                                    className="tma-wartable-btn"
                                    disabled={busy}
                                    onClick={() => setConfirmSurrender(false)}
                                >
                                    Never Mind
                                </button>
                            </>
                        ) : (
                            <button
                                className="tma-wartable-btn"
                                disabled={busy}
                                onClick={() => setConfirmSurrender(true)}
                            >
                                Surrender
                            </button>
                        )}
                    </div>
                    <div className="tma-wartable-card-row">
                        <select
                            className="tma-wartable-select"
                            value={terms}
                            onChange={(e) => setTerms(e.target.value)}
                            aria-label="Peace terms"
                        >
                            {PEACE_TERM_OPTIONS.map((t) => (
                                <option key={t.id} value={t.id}>
                                    {t.label}
                                </option>
                            ))}
                        </select>
                        {terms === "tribute" && (
                            <input
                                className="tma-wartable-select"
                                type="number"
                                min={1}
                                value={tribute}
                                onChange={(e) => setTribute(e.target.value)}
                                aria-label="Tribute amount"
                                style={{ width: 110 }}
                            />
                        )}
                        <button
                            className="tma-wartable-btn"
                            disabled={busy || !!pendingOffer}
                            onClick={() =>
                                runAction(
                                    `action=offer-peace&target=${encodeURIComponent(otherId)}&terms=${encodeURIComponent(terms)}` +
                                        (terms === "tribute"
                                            ? `&tribute=${encodeURIComponent(tribute)}`
                                            : "")
                                )
                            }
                        >
                            Offer Peace
                        </button>
                        {incomingOffer && (
                            <button
                                className="tma-wartable-btn"
                                disabled={busy}
                                onClick={() =>
                                    runAction(
                                        `action=accept-peace&target=${encodeURIComponent(otherId)}`
                                    )
                                }
                            >
                                Accept Their Terms
                            </button>
                        )}
                    </div>
                    {pendingOffer && (
                        <p className="tma-wartable-note">
                            Terms on the table:{" "}
                            {typeof pendingOffer.terms === "string"
                                ? pendingOffer.terms
                                : pendingOffer.terms.type +
                                  (pendingOffer.terms.amount
                                      ? ` (${fmtCoins(pendingOffer.terms.amount)} gp)`
                                      : "") +
                                  (pendingOffer.terms.days
                                      ? ` (${pendingOffer.terms.days} days)`
                                      : "")}{" "}
                            — offered by {pendingOffer.offeredByName}.
                        </p>
                    )}
                </>
            )}
        </div>
    );
}

/**
 * The war table content itself — the campaign map, its tabs, and the war
 * council. Rendered both by the in-world overlay and by the sidebar's War
 * Council tab; the surrounding chrome (backdrop vs. rail panel) is the
 * caller's job.
 */
export function WarTableView({
    status,
    tab,
    onTabChange,
    selectedId,
    onSelectKingdom,
    warTargetId,
    onWarTargetChange,
    warGoal,
    onWarGoalChange,
    busy,
    runAction,
}: {
    status: WarTableStatus;
    tab: WarTableTabId;
    onTabChange: (t: WarTableTabId) => void;
    selectedId: string | null;
    onSelectKingdom: (id: string) => void;
    warTargetId: string;
    onWarTargetChange: (id: string) => void;
    warGoal: string;
    onWarGoalChange: (id: string) => void;
    busy: boolean;
    runAction: (params: string) => void;
}): JSX.Element {
    const home = status.playerKingdom;
    const kingdomsById = new Map(status.kingdoms.map((k) => [k.id, k]));
    const selected = kingdomsById.get(selectedId ?? "") ?? kingdomsById.get(home?.id ?? "") ?? status.kingdoms[0];
    const maxTreasury = Math.max(1, ...status.kingdoms.map((k) => k.treasury));

    const warsFor = (id: string) =>
        status.wars.filter((w) => w.attacker === id || w.defender === id);
    const alliancesFor = (id: string) =>
        status.alliances.filter((a) => a.a === id || a.b === id);

    // War council (wars tab): target + goal selection, eligibility from the
    // server's warGates — the same checks the declare actions enforce.
    const councilTargets = home ? status.kingdoms.filter((k) => k.id !== home.id) : [];
    const councilTarget = warTargetId || councilTargets[0]?.id || "";
    const councilGoals = status.homeDetail?.warGoals ?? [];
    const councilGoal = warGoal || councilGoals[0]?.id || "";
    const councilGate = councilTarget ? status.warGates?.[councilTarget] ?? null : null;
    const councilTargetName = kingdomsById.get(councilTarget)?.name ?? councilTarget;

    return (
        <>
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

            {status.actionResult && (
                <p className={`tma-wartable-result ${status.actionResult.ok ? "ok" : "fail"}`}>
                    {status.actionResult.message}
                </p>
            )}

            <div className="tma-wartable-tabs" role="tablist">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={tab === t.id}
                        className={`tma-wartable-tab${tab === t.id ? " active" : ""}`}
                        onClick={() => onTabChange(t.id)}
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
                                        onClick={() => onSelectKingdom(k.id)}
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
                                                        {cl.share ?? 0}%
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
                                if (k.inCivilWar)
                                    badges.push({ text: "🔥 CIVIL WAR", color: "#a02020" });
                                else if (k.inSuccessionCrisis)
                                    badges.push({ text: "👑 THRONE DISPUTED", color: "#8b6f2e" });
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
                        <h2 className="tma-wartable-section-title">War Supply</h2>
                        {status.kingdoms.every((k) => (k.supply ?? []).length === 0) ? (
                            <p className="tma-wartable-empty">
                                No armies in the field — the wagons rest.
                            </p>
                        ) : (
                            <div className="tma-wartable-cards">
                                {status.kingdoms
                                    .filter((k) => (k.supply ?? []).length > 0)
                                    .map((k) =>
                                        (k.supply ?? []).map((d) => (
                                            <div key={`${k.id}-${d.warKey}`} className="tma-wartable-card">
                                                <div className="tma-wartable-card-title">
                                                    {k.name}
                                                    <span className="tma-wartable-muted">
                                                        {" "}· {d.role === "attacker" ? "attacking" : "defending"} {d.foeName}
                                                        {d.raid ? " (raid)" : ""}
                                                    </span>
                                                </div>
                                                <div className="tma-wartable-card-row">
                                                    <span className="tma-wartable-muted">Supply morale</span>
                                                    <span style={{ color: supplyColor(d.morale >= 1.05 ? 80 : d.morale >= 0.9 ? 60 : d.morale >= 0.78 ? 35 : 10) }}>
                                                        {d.moraleLabel} · {Math.round(d.morale * 100)}%
                                                    </span>
                                                </div>
                                                {(d.categories ?? []).map((c) => (
                                                    <div key={c.cat} className="tma-wartable-card-row">
                                                        <span className="tma-wartable-muted">{c.label}</span>
                                                        <span style={{ flex: 1, margin: "0 8px" }}>
                                                            <SupplyBar pct={c.pct} />
                                                        </span>
                                                        <span className="tma-wartable-muted">
                                                            {c.stock}/{c.quota}
                                                        </span>
                                                        {home?.id === k.id && c.stock < c.quota && (
                                                            <button
                                                                className="tma-wartable-btn"
                                                                disabled={busy}
                                                                onClick={() =>
                                                                    runAction(
                                                                        `action=contribute-supply&cat=${encodeURIComponent(c.cat)}`
                                                                    )
                                                                }
                                                            >
                                                                Contribute
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                                {home?.id === k.id && (
                                                    <div className="tma-wartable-card-sub">
                                                        Deliver provisions, arrows, runes and materials
                                                        to the donation chest in {k.capital ?? "the capital"} —
                                                        the army pays coin and the court remembers.
                                                    </div>
                                                )}
                                            </div>
                                        ))
                                    )}
                            </div>
                        )}
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
                        {home && councilTargets.length > 0 && (
                            <>
                                <h2 className="tma-wartable-section-title">War Council</h2>
                                <div className="tma-wartable-card">
                                    <div className="tma-wartable-card-row">
                                        <span className="tma-wartable-muted">Target</span>
                                        <select
                                            className="tma-wartable-select"
                                            value={councilTarget}
                                            onChange={(e) => onWarTargetChange(e.target.value)}
                                            aria-label="War council target"
                                        >
                                            {councilTargets.map((k) => (
                                                <option key={k.id} value={k.id}>
                                                    {k.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    {councilGoals.length > 0 && (
                                        <div className="tma-wartable-card-row">
                                            <span className="tma-wartable-muted">War goal</span>
                                            <span className="tma-wartable-goals">
                                                {councilGoals.map((g) => (
                                                    <button
                                                        key={g.id}
                                                        className={`tma-wartable-btn${councilGoal === g.id ? " selected" : ""}`}
                                                        onClick={() => onWarGoalChange(g.id)}
                                                    >
                                                        {g.label}
                                                    </button>
                                                ))}
                                            </span>
                                        </div>
                                    )}
                                    <div className="tma-wartable-card-row">
                                        <button
                                            className="tma-wartable-btn"
                                            disabled={busy || !councilGate?.declareWar.ok}
                                            onClick={() =>
                                                runAction(
                                                    `action=declare-war&target=${encodeURIComponent(councilTarget)}&goal=${encodeURIComponent(councilGoal)}`
                                                )
                                            }
                                        >
                                            Declare War
                                        </button>
                                        <button
                                            className="tma-wartable-btn"
                                            disabled={busy || !councilGate?.declareSiege.ok}
                                            onClick={() =>
                                                runAction(
                                                    `action=declare-siege&target=${encodeURIComponent(councilTarget)}&investment=0`
                                                )
                                            }
                                        >
                                            Declare Siege
                                        </button>
                                        <span className="tma-wartable-muted">
                                            War costs {status.warCosts?.warDeclareInfluence ?? "?"} influence ·{" "}
                                            siege costs {fmtCoins(status.warCosts?.siegeDeclareCoins ?? 0)} gp
                                            from the war chest
                                        </span>
                                    </div>
                                    {councilGate && !councilGate.declareWar.ok && (
                                        <p className="tma-wartable-gate-reason">
                                            War on {councilTargetName}: {councilGate.declareWar.message}
                                        </p>
                                    )}
                                    {councilGate && !councilGate.declareSiege.ok && (
                                        <p className="tma-wartable-gate-reason">
                                            Siege of {councilTargetName}: {councilGate.declareSiege.message}
                                        </p>
                                    )}
                                    <p className="tma-wartable-note">
                                        The council's answer binds the crown — declare only what
                                        {home.name} can finish.
                                    </p>
                                </div>
                            </>
                        )}
                        <h2 className="tma-wartable-section-title">Open Wars</h2>
                        {status.wars.length === 0 ? (
                            <p className="tma-wartable-empty">
                                No open wars — an uneasy peace.
                            </p>
                        ) : (
                            <div className="tma-wartable-cards">
                                {status.wars.map((w, i) => {
                                    const otherId = w.attacker === home?.id ? w.defender : w.attacker;
                                    const offer =
                                        status.homeDetail?.peaceOffers.find(
                                            (o) => o.otherId === otherId
                                        ) ?? null;
                                    const besieged = status.sieges.some(
                                        (s) => s.defenderId === home?.id && s.attackerId === otherId
                                    );
                                    return (
                                        <WarCard
                                            key={`${w.attacker}-${w.defender}-${i}`}
                                            war={w}
                                            homeId={home?.id ?? null}
                                            pendingOffer={offer}
                                            homeBesieged={besieged}
                                            busy={busy}
                                            runAction={runAction}
                                        />
                                    );
                                })}
                            </div>
                        )}
                        {status.intel && Object.keys(status.intel).length > 0 && (
                            <>
                                <h2 className="tma-wartable-section-title">Spies' Report</h2>
                                <div className="tma-wartable-cards">
                                    {Object.entries(status.intel).map(([id, intel]) => (
                                        <div key={id} className="tma-wartable-card">
                                            <div className="tma-wartable-card-title">
                                                {kingdomsById.get(id)?.name ?? id}
                                            </div>
                                            <div className="tma-wartable-card-sub">
                                                Garrison {intel.garrison} levies · militia{" "}
                                                {intel.militia} · fort tier {intel.fortTier} ·
                                                supply morale {Math.round(intel.morale * 100)}%
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
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
        </>
    );
}
