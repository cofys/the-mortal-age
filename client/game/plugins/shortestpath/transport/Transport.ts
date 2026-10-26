import { QUESTS } from "../quests";
import { distanceBetween2D, packWorldPoint, UNDEFINED } from "../WorldPointUtil";
import { type Branch, type ItemRequirement, TransportItems, type Unlock, UNLOCKS } from "./TransportItems";
import { TransportType, type TransportTypeDef } from "./TransportType";

export const UNDEFINED_ORIGIN = UNDEFINED;
export const UNDEFINED_DESTINATION = UNDEFINED;
/** An empty Origin or Destination cell: the row pairs with every row missing the other end. */
export const LOCATION_PERMUTATION = packWorldPoint(-1, -1, 1);

/** RuneLite's Skill names in Skill order (the client's SkillId), then total, combat and quest points. */
export const SKILL_NAMES = [
    "Attack", "Defence", "Strength", "Hitpoints", "Ranged", "Prayer", "Magic", "Cooking", "Woodcutting",
    "Fletching", "Fishing", "Firemaking", "Crafting", "Smithing", "Mining", "Herblore", "Agility", "Thieving",
    "Slayer", "Farming", "Runecraft", "Hunter", "Construction", "Sailing",
];
export const TOTAL_LEVEL_INDEX = SKILL_NAMES.length;
export const COMBAT_LEVEL_INDEX = SKILL_NAMES.length + 1;
export const QUEST_POINTS_INDEX = SKILL_NAMES.length + 2;
export const SKILL_LEVELS_LENGTH = SKILL_NAMES.length + 3;
/** "Max" in a Skills cell: the maximum the index allows. */
export const MAX_LEVEL = 2147483647;
const RANGED = 4;
const STRENGTH = 2;

export type VarCheckType = "&" | "@" | "=" | ">" | "<";
const VAR_CHECK_TYPES: readonly VarCheckType[] = ["&", "@", "=", ">", "<"];

export type VarRequirement = {
    readonly varType: "VARBIT" | "VARPLAYER";
    readonly id: number;
    readonly value: number;
    readonly checkType: VarCheckType;
};

export function checkVarValue(requirement: VarRequirement, currentValue: number, currentTimeMinutes: number): boolean {
    switch (requirement.checkType) {
        case "=": return currentValue === requirement.value;
        case ">": return currentValue > requirement.value;
        case "<": return currentValue < requirement.value;
        case "&": return (currentValue & requirement.value) > 0;
        case "@": return currentTimeMinutes - currentValue > requirement.value;
    }
}

export type Transport = {
    readonly origin: number;
    readonly destination: number;
    readonly type: TransportTypeDef;
    readonly skillLevels: readonly number[];
    readonly quests: readonly number[];
    readonly varRequirements: readonly VarRequirement[];
    readonly itemRequirements: TransportItems | null;
    readonly duration: number;
    readonly displayInfo: string | null;
    readonly isConsumable: boolean;
    readonly maxWildernessLevel: number;
    readonly objectInfo: string | null;
};

export function isUsableAtWildernessLevel(transport: Transport, wildernessLevel: number): boolean {
    return !transport.type.isTeleport || wildernessLevel <= transport.maxWildernessLevel;
}

// ------------------------------------------------------------------ TSV (TsvParser, TransportRecord)

export type TransportRecord = ReadonlyMap<string, string>;

/** TsvParser: a header line (commented or bare) names the tab-separated columns of every row. */
export function parseTsv(contents: string): TransportRecord[] {
    const lines = contents.split(/\r?\n/);
    if (lines.length === 0) return [];
    let header = lines[0];
    if (header.startsWith("# ")) header = header.slice(2);
    else if (header.startsWith("#")) header = header.slice(1);
    const headers = header.split("\t");
    const records: TransportRecord[] = [];
    for (const line of lines.slice(1)) {
        if (line.startsWith("#") || line.trim() === "") continue;
        const fields = line.split("\t");
        const record = new Map<string, string>();
        headers.forEach((name, i) => {
            if (i < fields.length) record.set(name, fields[i]);
        });
        records.push(record);
    }
    return records;
}

const has = (record: TransportRecord, field: string) => (record.get(field) ?? "") !== "";

// ------------------------------------------------------------------ field parsers

/** WorldPointParser: "x y plane"; empty (or malformed) is a permutation. */
export function parseWorldPoint(value: string | undefined): number {
    if (!value) return LOCATION_PERMUTATION;
    const parts = value.split(" ");
    return parts.length === 3 ? packWorldPoint(Number.parseInt(parts[0], 10), Number.parseInt(parts[1], 10), Number.parseInt(parts[2], 10))
        : LOCATION_PERMUTATION;
}

/** SkillRequirementParser: "70 Agility;50 Strength", "Max Total", "1500 Total", "100 Combat", "32 Quest". */
export function parseSkills(value: string | undefined): number[] {
    const levels = new Array<number>(SKILL_LEVELS_LENGTH).fill(0);
    if (!value) return levels;
    for (const requirement of value.split(";")) {
        if (!requirement) continue;
        const parts = requirement.split(" ");
        if (parts.length !== 2) continue;
        const level = parts[0] === "Max" ? MAX_LEVEL : Number.parseInt(parts[0], 10);
        if (!Number.isFinite(level)) continue;
        const name = parts[1];
        const skill = SKILL_NAMES.indexOf(name);
        if (skill >= 0) levels[skill] = level;
        const lower = name.toLowerCase();
        if (lower.startsWith("total")) levels[TOTAL_LEVEL_INDEX] = level;
        if (lower.startsWith("combat")) levels[COMBAT_LEVEL_INDEX] = level;
        if (lower.startsWith("quest")) levels[QUEST_POINTS_INDEX] = level;
    }
    return levels;
}

const QUEST_IDS = new Map(QUESTS.map(([id, name]) => [name, id]));

/** QuestParser: quest names (RuneLite's Quest names) separated by ";"; unknown names are dropped. */
export function parseQuests(value: string | undefined): number[] {
    if (!value) return [];
    const ids: number[] = [];
    for (const name of value.split(";")) {
        const id = QUEST_IDS.get(name);
        if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

/** VarRequirementParser: "4070=0;10032>0;4560&2;892@30". */
export function parseVarRequirements(value: string | undefined, varType: VarRequirement["varType"]): VarRequirement[] {
    if (!value) return [];
    const result: VarRequirement[] = [];
    for (const requirement of value.split(";")) {
        if (!requirement) continue;
        for (const checkType of VAR_CHECK_TYPES) {
            const parts = requirement.split(checkType);
            if (parts.length === 2) {
                const id = Number.parseInt(parts[0], 10);
                const v = Number.parseInt(parts[1], 10);
                if (Number.isFinite(id) && Number.isFinite(v)) result.push({ varType, id, value: v, checkType });
                break;
            }
        }
    }
    return result;
}

/** ItemVariations (item-variations.tsv): a named group of item ids, and the staves and offhands standing in for it. */
export type ItemVariation = { ids: number[]; staves: number[]; offhands: number[] };

export function parseItemVariations(contents: string): Map<string, ItemVariation> {
    const ids = (cell: string | undefined) => (cell ?? "").split(",").map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
    const variations = new Map<string, ItemVariation>();
    for (const record of parseTsv(contents)) {
        const name = record.get("name");
        if (name) variations.set(name, { ids: ids(record.get("ids")), staves: ids(record.get("staves")), offhands: ids(record.get("offhands")) });
    }
    return variations;
}

/**
 * ItemRequirementParser: "AIR_RUNE=3&FIRE_RUNE=1", "3853=1||3855=1", "AXE=1|UNLOCK_CANOE_AXE=1".
 * Returns null for an empty or malformed cell (upstream logs and drops it).
 */
export function parseItems(value: string | undefined, variations: ReadonlyMap<string, ItemVariation>): TransportItems | null {
    if (!value) return null;
    const normalized = value.replace(/ /g, "").replace(/&&/g, "&").replace(/\|\|/g, "|").toUpperCase();
    const requirements: ItemRequirement[] = [];
    for (const andPart of normalized.split("&")) {
        const branches: Branch[] = [];
        for (const orPart of andPart.split("|")) {
            const pair = orPart.split("=");
            if (pair.length !== 2) return null;
            const [name, quantityText] = pair;
            const quantity = Number.parseInt(quantityText, 10);
            if (!Number.isFinite(quantity)) return null;
            if (name.startsWith("UNLOCK_")) {
                const unlock = name.slice("UNLOCK_".length) as Unlock;
                if (!UNLOCKS.includes(unlock) || quantity < 1) throw new Error(`Unknown unlock token: ${orPart}`);
                branches.push({ itemIds: null, staffIds: null, offhandIds: null, quantity, unlock });
                continue;
            }
            const variation = variations.get(name);
            if (variation) {
                branches.push({
                    itemIds: variation.ids.length ? variation.ids : null,
                    staffIds: variation.staves.length ? variation.staves : null,
                    offhandIds: variation.offhands.length ? variation.offhands : null,
                    quantity,
                    unlock: null,
                });
            } else {
                const id = Number.parseInt(name, 10);
                if (!Number.isFinite(id)) return null;
                branches.push({ itemIds: [id], staffIds: null, offhandIds: null, quantity, unlock: null });
            }
        }
        requirements.push({ branches });
    }
    return requirements.length === 0 ? null : new TransportItems(requirements);
}

// ------------------------------------------------------------------ Transport and its builder

function build(fields: {
    origin: number; destination: number; type: TransportTypeDef; skillLevels: number[]; quests: number[];
    varRequirements: VarRequirement[]; itemRequirements: TransportItems | null; duration: number;
    displayInfo: string | null; isConsumable: boolean; maxWildernessLevel: number; objectInfo: string | null;
}): Transport {
    let type = fields.type;
    // AGILITY_SHORTCUT.refine: a shortcut needing Ranged or Strength is a crossbow grapple.
    if (type.name === "AGILITY_SHORTCUT" && (fields.skillLevels[RANGED] > 1 || fields.skillLevels[STRENGTH] > 1)) {
        type = TransportType.GRAPPLE_SHORTCUT;
    }
    // A teleport is never free, so its cost is not decided by walking distance.
    const duration = fields.type.isTeleport ? Math.max(fields.duration, 1) : fields.duration;
    return { ...fields, type, duration };
}

/** Transport(TransportRecord, TransportType). */
export function transportFromRecord(record: TransportRecord, type: TransportTypeDef, variations: ReadonlyMap<string, ItemVariation>): Transport {
    const int = (field: string) => {
        const n = Number.parseInt(record.get(field) ?? "", 10);
        return Number.isFinite(n) ? n : null;
    };
    const consumable = record.get("Consumable") ?? "";
    return build({
        origin: record.has("Origin") ? parseWorldPoint(record.get("Origin")) : UNDEFINED_ORIGIN,
        destination: record.has("Destination") ? parseWorldPoint(record.get("Destination")) : UNDEFINED_DESTINATION,
        type,
        skillLevels: parseSkills(record.get("Skills")),
        quests: parseQuests(record.get("Quests")),
        varRequirements: [
            ...parseVarRequirements(record.get("Varbits"), "VARBIT"),
            ...parseVarRequirements(record.get("VarPlayers"), "VARPLAYER"),
        ],
        itemRequirements: has(record, "Items") ? parseItems(record.get("Items"), variations) : null,
        duration: int("Duration") ?? 0,
        displayInfo: has(record, "Display info") ? record.get("Display info")! : null,
        isConsumable: consumable === "T" || consumable.toLowerCase() === "yes",
        maxWildernessLevel: int("Wilderness level") ?? -1,
        objectInfo: has(record, "menuOption menuTarget objectID") ? record.get("menuOption menuTarget objectID")! : null,
    });
}

/** Transport(origin, destination): a permutation row pair joined into one edge. */
export function combineTransports(origin: Transport, destination: Transport): Transport {
    const unique = <T>(values: T[]) => values.filter((v, i) => values.indexOf(v) === i);
    return build({
        origin: origin.origin,
        destination: destination.destination,
        type: origin.type,
        skillLevels: origin.skillLevels.map((level, i) => Math.max(level, destination.skillLevels[i])),
        quests: unique([...origin.quests, ...destination.quests]),
        varRequirements: [...origin.varRequirements, ...destination.varRequirements],
        itemRequirements: TransportItems.merge(origin.itemRequirements, destination.itemRequirements),
        duration: Math.max(origin.duration, destination.duration),
        displayInfo: destination.displayInfo,
        isConsumable: origin.isConsumable || destination.isConsumable,
        maxWildernessLevel: Math.max(origin.maxWildernessLevel, destination.maxWildernessLevel),
        objectInfo: origin.objectInfo,
    });
}

/**
 * ResourceLoader.addTransportsFromContents: a row with both ends is one edge (teleports have no
 * Origin column and sit under UNDEFINED_ORIGIN); a row with an empty Destination pairs with every
 * row with an empty Origin, unless their ends are within the type's radius threshold.
 */
export function addTransportsFromContents(transports: Map<number, Transport[]>, contents: string, type: TransportTypeDef,
    variations: ReadonlyMap<string, ItemVariation>): void {
    const origins: Transport[] = [];
    const destinations: Transport[] = [];
    const add = (transport: Transport) => {
        let list = transports.get(transport.origin);
        if (!list) transports.set(transport.origin, (list = []));
        list.push(transport);
    };
    for (const record of parseTsv(contents)) {
        const transport = transportFromRecord(record, type, variations);
        const { origin, destination } = transport;
        if ((origin === UNDEFINED_ORIGIN && destination === UNDEFINED_DESTINATION)
            || (origin === LOCATION_PERMUTATION && destination === LOCATION_PERMUTATION)) {
            continue;
        } else if (origin !== LOCATION_PERMUTATION && origin !== UNDEFINED_ORIGIN && destination === LOCATION_PERMUTATION) {
            origins.push(transport);
        } else if (origin === LOCATION_PERMUTATION && destination !== UNDEFINED_DESTINATION) {
            destinations.push(transport);
        }
        if (origin !== LOCATION_PERMUTATION && destination !== UNDEFINED_DESTINATION && destination !== LOCATION_PERMUTATION
            && (origin === UNDEFINED_ORIGIN || origin !== destination)) {
            add(transport);
        }
    }
    for (const origin of origins) {
        for (const destination of destinations) {
            if (distanceBetween2D(origin.origin, destination.destination) > type.radiusThreshold) {
                add(combineTransports(origin, destination));
            }
        }
    }
}
