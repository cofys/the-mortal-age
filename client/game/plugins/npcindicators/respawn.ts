/** A world tile (RuneLite's WorldPoint). */
export type WorldPoint = { readonly x: number; readonly y: number; readonly plane: number };

/** RuneLite's Actor view range: deaths and spawns further away than this are not learnt. */
export const MAX_ACTOR_VIEW_RANGE = 15;
/** Respawns slower than this many ticks are not believed. */
export const MAX_RESPAWN_TIME_TICKS = 500;
export const GAME_TICK_SECONDS = 0.6;

/** RuneLite's WorldPoint.distanceTo: the larger axis distance, or "far" on another plane. */
export function distanceTo(a: WorldPoint, b: WorldPoint): number {
    if (a.plane !== b.plane) return Number.MAX_SAFE_INTEGER;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function samePoint(a: WorldPoint, b: WorldPoint): boolean {
    return a.x === b.x && a.y === b.y && a.plane === b.plane;
}

const key = (p: WorldPoint) => `${p.x},${p.y},${p.plane}`;

/**
 * The tile behind an NPC facing `orientation` (0-2047, 0 = south): where it may have walked from
 * the tile it spawned on (RuneLite's getWorldLocationBehind).
 */
export function worldLocationBehind(location: WorldPoint, orientation: number): WorldPoint {
    const direction = Math.floor((((orientation % 2048) + 2048) % 2048) / 256);
    const [dx, dy] = [[0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1]][direction];
    return { x: location.x - dx, y: location.y - dy, plane: location.plane };
}

/** One NPC whose deaths and respawns are being learnt: RuneLite's MemorizedNpc. */
export class MemorizedNpc {
    diedOnTick = -1;
    respawnTime = -1;
    possibleRespawnLocations: WorldPoint[] = [];

    constructor(
        readonly npcIndex: number,
        readonly npcName: string,
        readonly npcSize: number,
    ) {}
}

type Seen = { index: number; location: WorldPoint; orientation: number };

/**
 * RuneLite NPC Indicators' respawn bookkeeping: despawns near the player record a death tick,
 * the next spawn near the player learns the shortest respawn time and the spawn tile.
 */
export class RespawnTracker {
    readonly memorized = new Map<number, MemorizedNpc>();
    /** NPCs whose respawn is being counted down, by index. */
    readonly deadNpcsToDisplay = new Map<number, MemorizedNpc>();
    private spawned: Seen[] = [];
    private despawned: { index: number; location: WorldPoint }[] = [];
    private readonly teleports = new Set<string>();
    private skipNextSpawnCheck = true;
    private lastPlayerLocation: WorldPoint | undefined;

    memorize(index: number, name: string, size: number): void {
        if (!this.memorized.has(index)) this.memorized.set(index, new MemorizedNpc(index, name, size));
    }

    forget(index: number): void {
        this.memorized.delete(index);
    }

    onSpawned(index: number, location: WorldPoint, orientation: number): void {
        this.spawned.push({ index, location, orientation });
    }

    /** Called for every despawn; only memorised NPCs are kept. */
    onDespawned(index: number, location: WorldPoint): void {
        if (this.memorized.has(index)) this.despawned.push({ index, location });
    }

    /** A teleport puff (SMOKEPUFF) at this tile: a despawn or spawn here isn't a death or respawn. */
    onTeleport(location: WorldPoint): void {
        this.teleports.add(key(location));
    }

    /** RuneLite's onGameTick: expire finished countdowns, then learn from this tick's events. */
    tick(tickCount: number, player: WorldPoint | undefined): void {
        for (const [index, npc] of this.deadNpcsToDisplay) {
            if (npc.diedOnTick + npc.respawnTime <= tickCount + 1) this.deadNpcsToDisplay.delete(index);
        }
        this.validateSpawnedNpcs(tickCount, player);
        this.lastPlayerLocation = player;
    }

    private validateSpawnedNpcs(tickCount: number, player: WorldPoint | undefined): void {
        if (this.skipNextSpawnCheck) {
            this.skipNextSpawnCheck = false;
        } else {
            for (const { index, location } of this.despawned) {
                if (this.teleports.has(key(location))) continue;
                const npc = this.memorized.get(index);
                if (!npc || !player || distanceTo(player, location) >= MAX_ACTOR_VIEW_RANGE) continue;
                npc.diedOnTick = tickCount + 1;
                if (npc.possibleRespawnLocations.length > 0) this.deadNpcsToDisplay.set(index, npc);
            }
            for (const { index, location, orientation } of this.spawned) {
                const behind = worldLocationBehind(location, orientation);
                if (this.teleports.has(key(location)) || this.teleports.has(key(behind))) continue;
                const npc = this.memorized.get(index);
                const last = this.lastPlayerLocation;
                if (!npc || !last || distanceTo(last, location) >= MAX_ACTOR_VIEW_RANGE) continue;
                if (npc.diedOnTick !== -1) {
                    const observed = tickCount + 1 - npc.diedOnTick;
                    if ((npc.respawnTime === -1 || observed < npc.respawnTime) && observed <= MAX_RESPAWN_TIME_TICKS) {
                        npc.respawnTime = observed;
                    }
                    npc.diedOnTick = -1;
                }
                const narrowed = npc.possibleRespawnLocations.filter((p) => samePoint(p, location) || samePoint(p, behind));
                npc.possibleRespawnLocations = narrowed.length > 0 ? narrowed : [location, behind];
            }
        }
        this.spawned = [];
        this.despawned = [];
        this.teleports.clear();
    }

    /** Login screen or hop: deaths in progress are forgotten, the countdowns cleared. */
    resetForHop(): void {
        for (const npc of this.memorized.values()) npc.diedOnTick = -1;
        this.deadNpcsToDisplay.clear();
        this.lastPlayerLocation = undefined;
        this.skipNextSpawnCheck = true;
    }

    clear(): void {
        this.memorized.clear();
        this.deadNpcsToDisplay.clear();
        this.spawned = [];
        this.despawned = [];
        this.teleports.clear();
        this.lastPlayerLocation = undefined;
        this.skipNextSpawnCheck = true;
    }
}

/** Seconds until the respawn (0.6 s a tick), counting down smoothly between ticks. */
export function respawnSecondsLeft(npc: MemorizedNpc, tickCount: number, msSinceTick: number): number {
    const base = (npc.diedOnTick + npc.respawnTime - tickCount) * GAME_TICK_SECONDS;
    return Math.max(0, base - msSinceTick / 1000);
}

/** RuneLite's "#0.0" (Locale.US) respawn text. */
export function formatRespawn(seconds: number): string {
    return (Math.round(seconds * 10) / 10).toFixed(1);
}
