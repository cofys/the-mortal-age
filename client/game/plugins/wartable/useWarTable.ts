import { useCallback, useEffect, useRef, useState } from "react";

import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";

export interface WarSupplyCategory {
    cat: string;
    label: string;
    quota: number;
    stock: number;
    pct: number;
}

export interface WarSupplyDemand {
    warKey: string;
    foe: string;
    foeName: string;
    role: string;
    raid: boolean;
    morale: number;
    moraleLabel: string;
    categories: WarSupplyCategory[];
}

export interface CoalitionRef {
    key: string;
    name: string;
}

export interface CastleInfo {
    fortTier: number;
    fortName: string;
    defense: number;
    troops: number;
    warChest: number;
    buildings: number;
}

export interface KingdomInfo {
    id: string;
    name: string;
    capital: string | null;
    ruler: string | null;
    rulerTitle: string | null;
    treasury: number;
    situation: string | null;
    castle: CastleInfo | null;
    relation: string | null;
    vassalOf: string | null;
    vassalOfName: string | null;
    vassalCount: number;
    underSiege: boolean;
    besiegingCount: number;
    atWar: boolean;
    coalition: CoalitionRef | null;
    inCivilWar: boolean;
    inSuccessionCrisis: boolean;
    supply: WarSupplyDemand[];
}

export interface SiegeInfo {
    attackerId: string;
    defenderId: string;
    attackerName: string;
    defenderName: string;
    progress: number;
    ticksElapsed: number;
    investment: number;
    warGoal: string | null;
    declaredAt: number | null;
    attackerMorale: number | null;
    defenderMorale: number | null;
}

export interface VassalageInfo {
    vassalId: string;
    vassalName: string;
    overlordId: string;
    overlordName: string;
    since: number | null;
}

export interface PeaceOfferInfo {
    otherId: string;
    otherName: string;
    offeredBy: string;
    offeredByName: string;
    terms: { type: string; amount?: number; days?: number } | string;
    offeredAt: number | null;
}

export interface WarGoalInfo {
    id: string;
    label: string;
}

export interface HomeDetail {
    castle: CastleInfo | null;
    vassalOf: string | null;
    vassalOfName: string | null;
    vassals: VassalageInfo[];
    peaceOffers: PeaceOfferInfo[];
    wars: WarInfo[];
    warGoals: WarGoalInfo[];
}

export interface ActionResult {
    ok: boolean;
    message: string;
    reason?: string;
}

export interface CoalitionMember {
    id: string;
    name: string;
}

export interface CoalitionInfo {
    key: string;
    name: string;
    members: CoalitionMember[];
    pactCount: number;
    totalStrength: number;
    formedAt: number | null;
}

export interface SuccessionClaimantInfo {
    id: string;
    name: string;
    title: string | null;
    claim: string | null;
    claimLabel: string | null;
    strength: number;
    share: number;
    backers: number;
}

export interface SuccessionCrisisInfo {
    id: string;
    kingdomId: string;
    kingdomName: string;
    lateRuler: string | null;
    ticksLeft: number | null;
    claimants: SuccessionClaimantInfo[];
}

export interface CivilWarSideInfo {
    name: string;
    title: string | null;
    strength: number;
}

export interface CivilWarInfo {
    id: string;
    kingdomId: string;
    kingdomName: string;
    sides: CivilWarSideInfo[];
    ticksLeft: number | null;
    drained: number;
}

export interface DefenseCallEntry {
    allyId: string;
    allyName: string;
    status: "deliberating" | "joined" | "absent" | "refused";
}

export interface DefenseCallInfo {
    attackerId: string;
    defenderId: string;
    attackerName: string;
    defenderName: string;
    calls: DefenseCallEntry[];
}

export interface WarInfo {
    attacker: string;
    defender: string;
    attackerName: string;
    defenderName: string;
    reason: string | null;
    goal: string | null;
    goalLabel: string | null;
    declaredAt: number | null;
    score: { attacker: number; defender: number } | null;
    battle: { id: string; status: string } | null;
}

export interface IntelInfo {
    garrison: number;
    morale: number;
    militia: number;
    fortTier: number;
}

export interface EndedWarInfo {
    attackerName: string;
    defenderName: string;
    outcome: string;
    endedAt: number | null;
}

export interface AllianceInfo {
    a: string;
    b: string;
    aName: string;
    bName: string;
    pactName: string | null;
    strength: number;
    formedAt: number | null;
}

export interface RelationInfo {
    a: string;
    b: string;
    tension: number;
    allied: boolean;
}

export interface PlayerKingdom {
    id: string;
    name: string;
    rank: string | null;
    influence: number;
}

export interface WarGate {
    ok: boolean;
    reason: string | null;
    message: string | null;
}

export interface WarGates {
    declareWar: WarGate;
    declareSiege: WarGate;
}

export interface WarCosts {
    warDeclareInfluence: number;
    siegeDeclareCoins: number;
}

export interface WarTableStatus {
    open: boolean;
    playerKingdom: PlayerKingdom | null;
    warCosts: WarCosts | null;
    warGates: Record<string, WarGates> | null;
    kingdoms: KingdomInfo[];
    wars: WarInfo[];
    endedWars: EndedWarInfo[];
    alliances: AllianceInfo[];
    relations: RelationInfo[];
    sieges: SiegeInfo[];
    vassalage: VassalageInfo[];
    coalitions: CoalitionInfo[];
    defenseCalls: DefenseCallInfo[];
    successionCrises: SuccessionCrisisInfo[];
    civilWars: CivilWarInfo[];
    homeDetail: HomeDetail | null;
    intel: Record<string, IntelInfo> | null;
    actionResult?: ActionResult;
}

export type WarTableTabId = "overview" | "realm" | "diplomacy" | "military" | "treasury" | "wars";

function statusUrl(username: string, suffix?: string): string {
    const base = `/api/wartable-status?player=${encodeURIComponent(username)}`;
    return suffix ? `${base}&${suffix}` : base;
}

/**
 * Polls the `wartable-status` endpoint every 3s and carries the table's UI
 * state (tab, selected kingdom, council target/goal) plus its actions.
 * Shared by the war table overlay and the sidebar's War Council tab — one
 * source of truth for the data and the actions the server enforces.
 *
 * Pass the client when the login screen should blank the panel (the overlay);
 * the sidebar panel omits it because the sidebar only renders while logged in.
 */
export function useWarTableStatus(osrsClient?: {
    isOnLoginScreen(): boolean;
} | null): {
    status: WarTableStatus | null;
    tab: WarTableTabId;
    setTab: (t: WarTableTabId) => void;
    selectedId: string | null;
    setSelectedId: (id: string | null) => void;
    warTargetId: string;
    setWarTargetId: (id: string) => void;
    warGoal: string;
    setWarGoal: (id: string) => void;
    busy: boolean;
    poll: () => Promise<void>;
    runAction: (params: string) => void;
    close: () => Promise<void>;
} {
    const [status, setStatus] = useState<WarTableStatus | null>(null);
    const [tab, setTab] = useState<WarTableTabId>("overview");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [warTargetId, setWarTargetId] = useState<string>("");
    const [warGoal, setWarGoal] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const pollRef = useRef<number | undefined>(undefined);

    const username = connectionState.sessionUsername;

    const poll = useCallback(async () => {
        if (!username || osrsClient?.isOnLoginScreen()) {
            setStatus(null);
            return;
        }
        try {
            const data = (await fetchContent(statusUrl(username))) as WarTableStatus;
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
        if (busy || !username) return;
        setBusy(true);
        try {
            await fetchContent(statusUrl(username, "action=close"));
        } catch {
            // Fall through; next poll picks up state.
        }
        window.setTimeout(() => {
            poll();
            setBusy(false);
        }, 600);
    }, [busy, username, poll]);

    const runAction = useCallback(
        (params: string) => {
            if (!username || busy) return;
            setBusy(true);
            void (async () => {
                try {
                    const data = (await fetchContent(
                        statusUrl(username, params)
                    )) as WarTableStatus;
                    setStatus(data);
                    window.setTimeout(poll, 400);
                } catch {
                    // Next poll refreshes.
                } finally {
                    setBusy(false);
                }
            })();
        },
        [username, busy, poll]
    );

    return {
        status,
        tab,
        setTab,
        selectedId,
        setSelectedId,
        warTargetId,
        setWarTargetId,
        warGoal,
        setWarGoal,
        busy,
        poll,
        runAction,
        close,
    };
}

/**
 * Marks the war table open/closed for the player. The in-world path uses this
 * too; the sidebar tab drives it while selected so the server-side open state
 * always matches what the player sees. Never throws.
 */
export async function setWarTableOpen(open: boolean): Promise<void> {
    const username = connectionState.sessionUsername;
    if (!username) return;
    try {
        await fetchContent(statusUrl(username, open ? "action=open" : "action=close"));
    } catch {
        // The poll loop converges anyway.
    }
}
