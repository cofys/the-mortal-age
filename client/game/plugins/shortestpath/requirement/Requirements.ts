import { QUESTS } from "../quests";
import type { TeleportationItem } from "../ShortestPathConfig";
import {
    checkVarValue,
    MAX_LEVEL,
    QUEST_POINTS_INDEX,
    SKILL_NAMES,
    TOTAL_LEVEL_INDEX,
    COMBAT_LEVEL_INDEX,
    type Transport,
} from "../transport/Transport";
import { TransportItems, type Unlock } from "../transport/TransportItems";
import { TransportType, type TransportTypeDef as TransportTypeT } from "../transport/TransportType";
import { packWorldPoint, unpackWorldX, unpackWorldY } from "../WorldPointUtil";

export type QuestState = "NOT_STARTED" | "IN_PROGRESS" | "FINISHED";

/**
 * Everything the gates read about the player, captured once per refresh (upstream's
 * RequirementContext). Levels are boosted, then total, combat and quest points.
 */
export type PlayerSnapshot = {
    readonly levels: readonly number[];
    readonly questState: (questId: number) => QuestState;
    readonly varbit: (id: number) => number;
    readonly varp: (id: number) => number;
    /** Inventory and worn items. */
    readonly carried: ReadonlyMap<number, number>;
    /** The bank as last seen, or null before it has been opened. */
    readonly bank: ReadonlyMap<number, number> | null;
    readonly currentTimeMinutes: number;
};

/** The routing settings the gates read (resolved config, with plugin-message overrides). */
export type RoutingSettings = {
    readonly enabled: (key: string) => boolean;
    readonly cost: (key: string) => number;
    readonly teleportationItem: TeleportationItem;
    readonly currencyThreshold: number;
    readonly respawnPrifddinas: boolean;
    readonly declaredUnlocks: ReadonlySet<Unlock>;
};

const LUMBRIDGE_RESPAWN = packWorldPoint(3221, 3218, 0);
const PRIFDDINAS_RESPAWN = packWorldPoint(3265, 6077, 0);
// Varbits PathfinderConfig and TransportEligibility read (gameval VarbitID).
const FAIRY2_QUEENCURE_QUEST = 2326;
const LUMBRIDGE_DIARY_ELITE_COMPLETE = 4498;
const KARAMJA_DIARY_ELITE_COMPLETE = 4566;
const questId = (name: string) => QUESTS.find(([, questName]) => questName === name)![0];
// The quests that gate whole transport networks.
const THE_GRAND_TREE = questId("The Grand Tree");
const BONE_VOYAGE = questId("Bone Voyage");
const TREE_GNOME_VILLAGE = questId("Tree Gnome Village");
/** ItemVariations.DRAMEN_STAFF: a fairy ring needs one until the Lumbridge elite diary. */
const DRAMEN_STAFF_IDS = [772, 9091, 9092, 9093, 9084];
const DRAMEN_STAFF = new TransportItems([{ branches: [{ itemIds: null, staffIds: DRAMEN_STAFF_IDS, offhandIds: null, quantity: 1, unlock: null }] }]);
const SKILL_COUNT = SKILL_NAMES.length;

/**
 * spirit-tree-patches.tsv: the farming patches a spirit tree can be planted in (x1, y1, x2, y2).
 * Upstream's SpiritTreeService reads which are grown; without it they count as not planted, as
 * upstream treats them before the service has answered.
 */
const SPIRIT_TREE_PATCHES: readonly [number, number, number, number][] = [
    [3058, 3256, 3062, 3260], // Port Sarim
    [2611, 3855, 2615, 3860], // Etceteria
    [2800, 3201, 2804, 3205], // Brimhaven
    [1691, 3540, 1695, 3544], // Hosidius
    [1251, 3748, 1255, 3752], // Farming Guild
];
const inSpiritTreePatch = (packed: number) => {
    const x = unpackWorldX(packed), y = unpackWorldY(packed);
    return SPIRIT_TREE_PATCHES.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
};

const isItemTeleportType = (type: TransportTypeT) => type === TransportType.TELEPORTATION_ITEM || type === TransportType.QUETZAL_WHISTLE;

/**
 * Shortest Path's requirement gate chain (Requirements.check) and item eligibility
 * (TransportEligibility.usable), without the bank-visit layer: a transport whose items are only in
 * the bank is usable when the teleportation item setting includes the bank. Returns the reason a
 * transport is rejected, or null when it can be used.
 */
export class Requirements {
    private readonly typeEnabled = new Map<TransportTypeT, boolean>();
    private readonly unlocks: ReadonlySet<Unlock>;
    private readonly ownedItems: ReadonlyMap<number, number>;
    private readonly fairyRingStaffRequired: boolean;

    constructor(private readonly player: PlayerSnapshot, private readonly settings: RoutingSettings) {
        const unlocks = new Set(settings.declaredUnlocks);
        if (player.varbit(KARAMJA_DIARY_ELITE_COMPLETE) === 1) unlocks.add("KARAMJA_ELITE");
        this.unlocks = unlocks;
        const bankToo = settings.teleportationItem === "INVENTORY_AND_BANK" || settings.teleportationItem === "INVENTORY_AND_BANK_NON_CONSUMABLE";
        const owned = new Map(player.carried);
        if (bankToo && player.bank) for (const [id, quantity] of player.bank) owned.set(id, (owned.get(id) ?? 0) + quantity);
        this.ownedItems = owned;
        this.fairyRingStaffRequired = player.varbit(LUMBRIDGE_DIARY_ELITE_COMPLETE) !== 1;

        // PathfinderConfig.refreshTransports: a whole network is off until its unlocking quest.
        const finished = (quest: number) => player.questState(quest) === "FINISHED";
        this.disableUnless(TransportType.FAIRY_RING, player.varbit(FAIRY2_QUEENCURE_QUEST) > 39);
        this.disableUnless(TransportType.GNOME_GLIDER, finished(THE_GRAND_TREE));
        this.disableUnless(TransportType.MAGIC_MUSHTREE, finished(BONE_VOYAGE));
        this.disableUnless(TransportType.SPIRIT_TREE, finished(TREE_GNOME_VILLAGE));
    }

    private disableUnless(type: TransportTypeT, condition: boolean): void {
        if (!condition) this.typeEnabled.set(type, false);
    }

    private isTypeEnabled(type: TransportTypeT): boolean {
        const forced = this.typeEnabled.get(type);
        if (forced !== undefined) return forced;
        if (type === TransportType.TELEPORTATION_ITEM) return this.settings.teleportationItem !== "NONE";
        return type.enabledKey === null || this.settings.enabled(type.enabledKey);
    }

    /** PathfinderConfig.getAdditionalTransportCost. */
    additionalCost(transport: Transport): number {
        const typeCost = transport.type.costKey ? this.settings.cost(transport.type.costKey) : 0;
        if (transport.isConsumable && transport.type === TransportType.TELEPORTATION_ITEM) return this.settings.cost("costConsumableTeleportationItems");
        if (transport.isConsumable && transport.type === TransportType.QUETZAL_WHISTLE) return typeCost + this.settings.cost("costConsumableTeleportationItems");
        return typeCost;
    }

    /** PathfinderConfig.getDifferentialCost. */
    differentialCost(transport: Transport): number {
        return transport.type.differentialCostKey ? this.settings.cost(transport.type.differentialCostKey) : 0;
    }

    check(transport: Transport): string | null {
        if (!this.isTypeEnabled(transport.type)) return "TYPE_DISABLED";
        const mode = this.teleportationItemMode(transport);
        if (mode) return mode;
        if (!this.respawnGate(transport)) return "RESPAWN_DECLARED";
        if (!this.unlockGates(transport)) return "UNLOCK_GATE";
        if (!this.skillLevels(transport.skillLevels)) return "SKILL_LEVEL";
        if (transport.quests.some((quest) => this.player.questState(quest) !== "FINISHED")) return "QUEST";
        for (const requirement of transport.varRequirements) {
            const value = requirement.varType === "VARBIT" ? this.player.varbit(requirement.id) : this.player.varp(requirement.id);
            if (!checkVarValue(requirement, value, this.player.currentTimeMinutes)) return requirement.varType === "VARBIT" ? "VARBIT" : "VARPLAYER";
        }
        if ((transport.type === TransportType.SPIRIT_TREE || transport.type === TransportType.TELEPORTATION_ITEM)
            && (inSpiritTreePatch(transport.origin) || inSpiritTreePatch(transport.destination))) {
            return "PLANTED_SPIRIT_TREE";
        }
        if (!this.itemsUsable(transport)) return "ITEM_REQUIREMENT";
        return null;
    }

    usable(transport: Transport): boolean {
        return this.check(transport) === null;
    }

    private teleportationItemMode(transport: Transport): string | null {
        if (!isItemTeleportType(transport.type)) return null;
        switch (this.settings.teleportationItem) {
            case "NONE": return "TELEPORT_MODE";
            case "ALL_NON_CONSUMABLE":
            case "UNLOCKED_NON_CONSUMABLE":
            case "INVENTORY_NON_CONSUMABLE":
            case "INVENTORY_AND_BANK_NON_CONSUMABLE":
                return transport.isConsumable ? "TELEPORT_MODE" : null;
            default: return null;
        }
    }

    // Respawn rows: Prifddinas reads like the Lumbridge default, so the config decides both.
    private respawnGate(transport: Transport): boolean {
        if (!transport.displayInfo?.includes("Respawn")) return true;
        if (transport.destination === PRIFDDINAS_RESPAWN) return this.settings.respawnPrifddinas;
        if (transport.destination === LUMBRIDGE_RESPAWN) return !this.settings.respawnPrifddinas;
        return true;
    }

    private unlockGates(transport: Transport): boolean {
        const items = transport.itemRequirements;
        if (!items) return true;
        return items.requirements.every((r) => !TransportItems.isPureUnlock(r) || r.branches.some((b) => b.unlock && this.unlocks.has(b.unlock)));
    }

    // SkillLevels.missingRequirement; "Max" is the most the index allows.
    private skillLevels(required: readonly number[]): boolean {
        for (let i = 0; i < required.length; i++) {
            let level = required[i];
            if (level === 0) continue;
            if (level === MAX_LEVEL) {
                level = i < TOTAL_LEVEL_INDEX ? 99 : i === TOTAL_LEVEL_INDEX ? 99 * SKILL_COUNT : i === COMBAT_LEVEL_INDEX ? 126
                    : i === QUEST_POINTS_INDEX ? Infinity : MAX_LEVEL;
            }
            if ((this.player.levels[i] ?? 0) < level) return false;
        }
        return true;
    }

    private itemsUsable(transport: Transport): boolean {
        const type = transport.type;
        if (type === TransportType.TELEPORTATION_ITEM || type === TransportType.QUETZAL_WHISTLE) {
            // "All" and "Unlocked" don't check items; upstream's "Unlocked" reads collection unlocks this port lacks.
            const mode = this.settings.teleportationItem;
            if (mode === "ALL" || mode === "UNLOCKED" || mode === "ALL_NON_CONSUMABLE" || mode === "UNLOCKED_NON_CONSUMABLE") return true;
        }
        if (type === TransportType.FAIRY_RING && this.fairyRingStaffRequired
            && !DRAMEN_STAFF.isSatisfiedBy(this.ownedItems, this.settings.currencyThreshold, this.unlocks)) {
            return false;
        }
        const items = transport.itemRequirements;
        if (!items) return true;
        const unlocks = type === TransportType.HOT_AIR_BALLOON && this.settings.declaredUnlocks.has("BALLOON_LOG_BASKET")
            ? new Set([...this.unlocks, "BALLOON_LOG_BASKET" as Unlock]) : this.unlocks;
        return items.isSatisfiedBy(this.ownedItems, this.settings.currencyThreshold, unlocks);
    }
}
