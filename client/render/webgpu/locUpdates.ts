/**
 * World-object (LOC) updates for the WebGPU backend: port of render/render/locs.ts, locs2.ts,
 * streaming.ts (refreshGamemodeWorldLocs) and WebGLOsrsRenderer.onRegionReplacement.
 *
 * Packets update the renderer's loc state (locOverrides, locSpawns, addedLocs, terrain and region
 * replacements), which every map build hands to the worker; the affected map squares are then
 * rebuilt in a debounced batch and replace the drawn squares in place. Each map has a reload
 * version: a build started before a change is dropped when it completes (`isCurrent`).
 *
 * As in WebGL (scheduleLocGeometryUpdate), a change that only touches doors rebuilds just the
 * square's door geometry, one that only touches other locs just its loc geometry (the worker skips
 * terrain and the other group: SdMapLoaderInput.doorOnly/locOnly); anything else, or a mix of
 * groups changed before a build is applied, rebuilds the whole square.
 */
import type { WebGLOsrsRendererHost } from "../render/hostInterface";
import { getLocAnimationDurationMs } from "../render/locs2";
import { applyGamemodeWorldLocs } from "../render/streaming";
import { RENDER_CONSTANTS } from "../render/constants";
import { LocModelType } from "../../rs/config/loctype/LocModelType";
import { isDoorLocType } from "../loc/SceneLocs";
import { getMapSquareId } from "../../rs/map/MapFileIndex";
import type { LocChangeOptions, RegionReplacementEvent } from "../../game/GameRenderer";
import type { WebGPURenderer } from "./WebGPURenderer";

type Tile = { x: number; y: number };
/** Which geometry a reload rebuilds. */
export type LocReloadGroup = "door" | "loc" | "full";

function mergeGroups(a: LocReloadGroup | undefined, b: LocReloadGroup): LocReloadGroup {
    return a === undefined || a === b ? b : "full";
}

export class LocUpdates {
    // Read and replaced by applyGamemodeWorldLocs (shared with WebGL through this facade).
    gamemodeWorldLocOverrideKeys = new Set<string>();
    gamemodeWorldLocSpawnKeys = new Set<string>();
    gamemodeWorldTerrainOverrideKeys = new Set<string>();

    private readonly versions = new Map<number, number>();
    private readonly pending = new Map<number, Tile>();
    /** Groups changed since each square last applied a current build. */
    private readonly dirty = new Map<number, LocReloadGroup>();
    private flushTimer?: ReturnType<typeof setTimeout>;
    private readonly animTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly r: WebGPURenderer) {}

    get locOverrides() {
        return this.r.locOverrides;
    }
    get locSpawns() {
        return this.r.locSpawns;
    }
    get terrainOverrides() {
        return this.r.terrainOverrides;
    }
    getMapIdForWorldTile(x: number, y: number): number {
        return getMapSquareId(x >> 6, y >> 6);
    }

    /** Reload version of a map square; a build is current while it still matches. */
    version(mapX: number, mapY: number): number {
        return this.versions.get(getMapSquareId(mapX, mapY)) ?? 0;
    }

    isCurrent(mapX: number, mapY: number, version: number): boolean {
        return this.version(mapX, mapY) === version;
    }

    /** A current build was applied: it includes every change so far. */
    applied(mapX: number, mapY: number): void {
        this.dirty.delete(getMapSquareId(mapX, mapY));
    }

    /** "door"/"loc" when every id is known and in that group, else "full" (locs.ts onLocChange). */
    private groupOf(...ids: number[]): LocReloadGroup {
        let doors = 0;
        let locs = 0;
        for (const id of ids) {
            if ((id | 0) <= 0) continue;
            const type = this.r.osrsClient.locTypeLoader.load(id | 0);
            if (!type) return "full";
            if (isDoorLocType(type)) doors++;
            else locs++;
        }
        if (doors > 0 && locs === 0) return "door";
        if (locs > 0 && doors === 0) return "loc";
        return "full";
    }

    /** LOC_DEL carries no id: find it in the square's per-tile loc index (locs2.ts onLocDel). */
    private idAt(tile: Tile, level: number, shape: number, rotation: number): number {
        const square = this.r.mapManager.getMap(tile.x >> 6, tile.y >> 6);
        if (!square) return -1;
        const lx = tile.x - square.getRenderBaseWorldX();
        const ly = tile.y - square.getRenderBaseWorldY();
        const typeRots = square.getLocTypeRotsAtLocal(level, lx, ly).slice();
        const ids = square.getLocIdsAtLocal(level, lx, ly);
        for (let i = 0; i < ids.length; i++) {
            if ((typeRots[i] & 0x3f) === (shape & 0x3f) && ((typeRots[i] >> 6) & 3) === (rotation & 3)) return ids[i];
        }
        return -1;
    }

    /** Gamemode world loc/terrain changes, re-applied before every map build (streaming2.ts). */
    applyGamemode(): Set<number> {
        return applyGamemodeWorldLocs(this as unknown as WebGLOsrsRendererHost);
    }

    onLocChange(oldId: number, newId: number, tile: Tile, level: number, opts?: LocChangeOptions): void {
        const oldTile = opts?.oldTile ?? tile;
        const newTile = opts?.newTile;
        const overrideRotation = typeof opts?.newRotation === "number" ? opts.newRotation & 0x3 : undefined;
        const spawnKey = `${oldTile.x | 0},${oldTile.y | 0},${level | 0}`;
        const existingSpawn = this.r.locSpawns.get(spawnKey);
        // Locs spawned on empty ground (oldId 0) and the lifecycle of a spawned loc use locSpawns.
        const isSpawnedLoc = (oldId | 0) === 0 || (existingSpawn !== undefined && existingSpawn.id === (oldId | 0));

        for (const t of newTile ? [oldTile, newTile] : [oldTile]) {
            const prefix = `${t.x | 0},${t.y | 0},${level},`;
            for (const key of Array.from(this.r.locOverrides.keys())) {
                if (key.startsWith(prefix)) this.r.locOverrides.delete(key);
            }
        }

        if (isSpawnedLoc) {
            if ((newId | 0) === 0) {
                this.r.locSpawns.delete(spawnKey);
            } else {
                // The server's shape (loc_add_change_v2), else the existing spawn's, else NORMAL.
                const type = typeof opts?.newShape === "number" ? opts.newShape : existingSpawn?.type ?? LocModelType.NORMAL;
                this.r.locSpawns.set(spawnKey, { id: newId | 0, type, rotation: overrideRotation ?? 0 });
            }
        } else {
            const moved = newTile && ((newTile.x | 0) !== (oldTile.x | 0) || (newTile.y | 0) !== (oldTile.y | 0));
            this.r.locOverrides.set(`${oldTile.x},${oldTile.y},${level},${oldId}`, {
                newId: newId | 0,
                newRotation: overrideRotation,
                moveToX: moved ? newTile!.x | 0 : undefined,
                moveToY: moved ? newTile!.y | 0 : undefined,
            });
        }

        // A moving loc can cross a map-square edge (e.g. a gate): reload both squares.
        const group = this.groupOf(oldId, newId);
        this.reloadTile(oldTile, group);
        if (newTile) this.reloadTile(newTile, group);
    }

    onLocAddChange(locId: number, tile: Tile, level: number, shape: number, rotation: number): void {
        const key = `${tile.x},${tile.y},${level},${shape}`;
        const overrideKey = `${tile.x | 0},${tile.y | 0},${level | 0},-1`;
        const existing = this.r.addedLocs.get(key);
        const existingOverride = this.r.locOverrides.get(overrideKey);
        const preservesOtherShapeRemoval =
            existingOverride?.newId === 0 &&
            typeof existingOverride.matchType === "number" &&
            existingOverride.matchType !== shape;
        if (
            existing?.locId === locId &&
            existing.rotation === rotation &&
            existingOverride?.newId === 0 &&
            (existingOverride.matchType === shape || preservesOtherShapeRemoval)
        ) {
            return;
        }
        this.r.addedLocs.set(key, { locId, x: tile.x, y: tile.y, level, shape, rotation });
        // Suppress the cache loc at this tile, which the new one replaces.
        this.r.locOverrides.set(preservesOtherShapeRemoval ? `${overrideKey},${shape}` : overrideKey, {
            newId: 0,
            matchType: shape,
        });
        this.reloadTile(tile, this.groupOf(locId));
    }

    onLocDel(tile: Tile, level: number, shape: number, rotation: number): void {
        const deletedId = this.idAt(tile, level, shape, rotation);
        this.r.addedLocs.delete(`${tile.x},${tile.y},${level},${shape}`);
        // Suppress the cache loc so a removed object (e.g. a chopped tree) disappears.
        let overrideKey = `${tile.x | 0},${tile.y | 0},${level | 0},-1`;
        let existingOverride = this.r.locOverrides.get(overrideKey);
        if (typeof existingOverride?.matchType === "number" && existingOverride.matchType !== shape) {
            overrideKey += `,${shape}`;
            existingOverride = this.r.locOverrides.get(overrideKey);
        }
        if (
            existingOverride?.newId !== 0 ||
            typeof existingOverride.matchType !== "number" ||
            existingOverride.matchType === shape
        ) {
            this.r.locOverrides.set(overrideKey, { newId: 0, matchType: shape });
        }
        this.reloadTile(tile, deletedId > 0 ? this.groupOf(deletedId) : "full");
    }

    onLocAnim(locId: number, tile: Tile, level: number, shape: number, rotation: number, animId: number): void {
        if ((shape | 0) < 0) return;
        const exactKey = `${tile.x | 0},${tile.y | 0},${level | 0},${locId | 0}`;
        const matchKey = `${tile.x | 0},${tile.y | 0},${level | 0},-1`;
        // A loc the server added is found by its own id; the tile-wide key there holds the
        // removal of the cache loc it replaced, which must survive the animation.
        const added = this.r.addedLocs.get(`${tile.x | 0},${tile.y | 0},${level | 0},${shape | 0}`);
        const onAddedLoc = added !== undefined && (added.locId | 0) === (locId | 0);
        const keys = onAddedLoc ? [exactKey] : [exactKey, matchKey];
        for (const key of keys) {
            clearTimeout(this.animTimers.get(key));
            this.animTimers.delete(key);
        }
        this.r.locOverrides.set(exactKey, {
            newId: locId | 0,
            newRotation: rotation & 0x3,
            seqId: animId | 0,
            seqRandomStart: false,
        });
        if (!onAddedLoc) {
            this.r.locOverrides.set(matchKey, {
                newId: -1,
                newRotation: rotation & 0x3,
                seqId: animId | 0,
                seqRandomStart: false,
                matchType: shape,
                matchRotation: rotation & 0x3,
            });
        }
        const group = this.groupOf(locId);
        this.reloadTile(tile, group);

        // As in OSRS, a sequence with a frame step loops (or holds its last frames) until the
        // loc is animated again or changed; one without plays once and reverts.
        let loops = false;
        try {
            loops = ((this.r.osrsClient.seqTypeLoader.load(animId | 0) as { frameStep?: number })?.frameStep ?? -1) > 0;
        } catch {}
        if (loops) return;
        const host = this.r as unknown as WebGLOsrsRendererHost;
        const timer = setTimeout(() => {
            let changed = false;
            for (const key of keys) {
                const current = this.r.locOverrides.get(key);
                if (current && (current.seqId ?? -1) === (animId | 0)) {
                    this.r.locOverrides.delete(key);
                    changed = true;
                }
                this.animTimers.delete(key);
            }
            if (changed) this.reloadTile(tile, group);
        }, getLocAnimationDurationMs(host, animId));
        for (const key of keys) this.animTimers.set(key, timer);
    }

    refreshGamemodeWorldLocs(): void {
        const affected = this.applyGamemode();
        if (!this.r.osrsClient.loadedCache || this.r.instanceActive) return;
        for (const mapId of affected) this.scheduleReload(mapId >> 8, mapId & 0xff);
    }

    onRegionReplacement(payload: RegionReplacementEvent): void {
        const regionId = payload.regionId | 0;
        if (regionId < 0 || regionId > 0xffff || payload.terrainData.length === 0) return;
        this.r.mapRegionReplacements.set(regionId, {
            terrainData: Int8Array.from(payload.terrainData),
            objectData: payload.objectData?.length ? Int8Array.from(payload.objectData) : undefined,
        });
        if (payload.allowReload) this.scheduleReload(regionId >> 8, regionId & 0xff);
    }

    /** Instances rebuild their whole scene; elsewhere the tile's map square reloads. */
    private reloadTile(tile: Tile, group: LocReloadGroup): void {
        if (this.r.instanceActive) {
            this.r.scheduleInstanceLocRebuild();
            return;
        }
        this.scheduleReload(Math.floor(tile.x / 64), Math.floor(tile.y / 64), group);
    }

    /** Port of scheduleLocReload: bump the version, then rebuild loaded/loading squares in a batch. */
    scheduleReload(mapX: number, mapY: number, group: LocReloadGroup = "full"): void {
        const id = getMapSquareId(mapX, mapY);
        this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
        // A build in flight for another group is now stale, so this one must cover both.
        this.dirty.set(id, mergeGroups(this.dirty.get(id), group));
        // Not loaded or loading: its next load reads the current state anyway.
        if (!this.r.mapManager.getMap(mapX, mapY) && !this.r.mapManager.loadingMapIds.has(id)) return;
        this.pending.set(id, { x: mapX | 0, y: mapY | 0 });
        this.flushTimer ??= setTimeout(() => {
            this.flushTimer = undefined;
            const batch = Array.from(this.pending.values());
            this.pending.clear();
            for (const map of batch) {
                this.r.queueLocReload(map.x, map.y, this.dirty.get(getMapSquareId(map.x, map.y)) ?? "full");
            }
        }, RENDER_CONSTANTS.LOC_RELOAD_FLUSH_DELAY_MS);
    }

    /** Drops queued work; also the per-session reset, so it must leave the instance usable. */
    dispose(): void {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        for (const timer of this.animTimers.values()) clearTimeout(timer);
        this.animTimers.clear();
        this.pending.clear();
        this.dirty.clear();
        this.gamemodeWorldLocOverrideKeys.clear();
        this.gamemodeWorldLocSpawnKeys.clear();
        this.gamemodeWorldTerrainOverrideKeys.clear();
    }
}
