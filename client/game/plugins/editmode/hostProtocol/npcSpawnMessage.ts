export const NPC_SPAWN_REQUEST_MESSAGE = "elvarg:npc-spawns-request";
export const NPC_SPAWN_MESSAGE = "elvarg:npc-spawns";
export const CUSTOM_NPC_SPAWNS_MESSAGE = "elvarg:custom-npc-spawns";
export type BrowserHostNpcSpawn = {
    id: number;
    tileX: number;
    tileY: number;
    plane: number;
    direction?: number;
    /** Wandering range; 0 anchors the NPC. Omitted means the server default. */
    wanderRadius?: number;
    /** Marks a persisted game spawn as removed rather than added. */
    remove?: boolean;
};
export type NpcSpawnRequestMessage = { type: typeof NPC_SPAWN_REQUEST_MESSAGE; regionIds: number[] };
export type NpcSpawnMessage = { type: typeof NPC_SPAWN_MESSAGE; regionIds: number[]; spawns: BrowserHostNpcSpawn[] };
export type CustomNpcSpawnsMessage = { type: typeof CUSTOM_NPC_SPAWNS_MESSAGE; spawns: BrowserHostNpcSpawn[] };

/** One edited spawn, in the on-disk npc-spawns.json shape. */
export type EditedNpcSpawn = {
    id: number;
    x: number;
    y: number;
    level: number;
    direction?: number;
    wanderRadius?: number;
    remove?: boolean;
};

export function regionIdForTile(tileX: number, tileY: number): number {
    return ((tileX >> 6) << 8) | (tileY >> 6);
}

/** Identity of a persisted spawn, used to hide and restore it across map reloads. */
export function npcSpawnKey(spawn: { id: number; tileX: number; tileY: number; plane: number }): string {
    return `${spawn.id}:${spawn.tileX}:${spawn.tileY}:${spawn.plane}`;
}

/**
 * One spawn record from npc-spawns.json or its editor patch. Entries named by
 * an NpcIdentifiers `key` have no numeric id here (the client has no
 * identifiers table), so they are skipped.
 */
export type NpcSpawnRecord = {
    id: number;
    tileX: number;
    tileY: number;
    plane: number;
    direction?: number;
    wanderRadius?: number;
    remove?: boolean;
};

export function parseNpcSpawnRecords(contents: string): NpcSpawnRecord[] {
    if (typeof contents !== "string" || contents.length > 20_000_000) throw new Error("Invalid npc-spawns.json");
    const parsed = JSON.parse(contents);
    const integer = (value: unknown, max: number) =>
        Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
    if (!Array.isArray(parsed) || parsed.some((spawn) =>
        !spawn
        || !integer(spawn.x, 0x3fff)
        || !integer(spawn.y, 0x3fff)
        || !integer(spawn.level, 3)
        || (!integer(spawn.id, 0x7fffffff) && typeof spawn.key !== "string")
        || (spawn.direction !== undefined && !integer(spawn.direction, 7))
        || (spawn.wanderRadius !== undefined && !integer(spawn.wanderRadius, 255))
        || (spawn.remove !== undefined && typeof spawn.remove !== "boolean")
    )) throw new Error("Invalid npc-spawns.json");
    return parsed.flatMap((spawn): NpcSpawnRecord[] => {
        if (!integer(spawn.id, 0x7fffffff)) return [];
        return [{
            id: spawn.id,
            tileX: spawn.x,
            tileY: spawn.y,
            plane: spawn.level,
            ...(Number.isInteger(spawn.direction) ? { direction: spawn.direction } : {}),
            ...(Number.isInteger(spawn.wanderRadius) ? { wanderRadius: spawn.wanderRadius } : {}),
            ...(spawn.remove === true ? { remove: true } : {}),
        }];
    });
}

/** The playable spawns in a file; removal markers are dropped. */
export function parseNpcSpawns(contents: string): BrowserHostNpcSpawn[] {
    return parseNpcSpawnRecords(contents).flatMap((record): BrowserHostNpcSpawn[] => {
        if (record.remove) return [];
        return [{
            id: record.id,
            tileX: record.tileX,
            tileY: record.tileY,
            plane: record.plane,
            ...(record.direction === undefined ? {} : { direction: record.direction }),
            ...(record.wanderRadius === undefined ? {} : { wanderRadius: record.wanderRadius }),
        }];
    });
}

export function formatCustomNpcSpawns(spawns: readonly EditedNpcSpawn[]): string {
    return spawns.length ? "[\n" + spawns.map((spawn) => "  " + JSON.stringify(spawn)).join(",\n") + "\n]\n" : "[]\n";
}
