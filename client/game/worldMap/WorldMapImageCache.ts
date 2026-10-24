import { MapManager } from "../MapManager";
import type { MinimapIcon } from "../../render/loader/SdMapData";
import type { WorldMapArchiveRenderer } from "../../rs/map/WorldMapArchiveRenderer";
import { isTouchDevice } from "../../common/utils/DeviceUtil";
import {
    BASE_PENDING_WORLDMAP_TILE_LOADS,
    BASE_PENDING_WORLDMAP_TILE_LOADS_MOBILE,
    MAX_FAILED_WORLDMAP_IDS,
    MAX_FAILED_WORLDMAP_IDS_MOBILE,
    MAX_PENDING_WORLDMAP_TILE_LOADS,
    MAX_PENDING_WORLDMAP_TILE_LOADS_MOBILE,
    MAX_WORLDMAP_URLS,
    MAX_WORLDMAP_URLS_MOBILE,
    WORLDMAP_TILE_RETRY_MS,
    type WorldMapImageTile,
    type WorldMapRetainTile,
    type WorldMapStateHolder,
} from "./WorldMapTypes";

export type WorldMapImageDeps = {
    getMinimapImageKey: (mapX: number, mapY: number, level?: number) => number;
    getWorldMapArchiveRenderer: () => Pick<WorldMapArchiveRenderer, "loadTile"> | undefined;
    cancelTileLoads?: (clearCache?: boolean) => void;
    loadMapElement: (elementId: number) => any;
    getWidgetManager: () => any;
    evictTextureKey: (key: string) => void;
    scheduleRepaint: () => void;
};

function getWorldMapImageLimit(): number {
    return isTouchDevice ? MAX_WORLDMAP_URLS_MOBILE : MAX_WORLDMAP_URLS;
}

function getWorldMapImagePendingLimit(state: WorldMapStateHolder): number {
    const baseLimit = isTouchDevice
        ? BASE_PENDING_WORLDMAP_TILE_LOADS_MOBILE
        : BASE_PENDING_WORLDMAP_TILE_LOADS;
    const maxLimit = isTouchDevice
        ? MAX_PENDING_WORLDMAP_TILE_LOADS_MOBILE
        : MAX_PENDING_WORLDMAP_TILE_LOADS;
    return Math.max(baseLimit, Math.min(maxLimit, state.retainedWorldMapImageIds.size));
}

function getFailedWorldMapIdLimit(): number {
    return isTouchDevice ? MAX_FAILED_WORLDMAP_IDS_MOBILE : MAX_FAILED_WORLDMAP_IDS;
}

export function getWorldMapImageKey(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    mapX: number,
    mapY: number,
    level: number = 0,
): number {
    const baseKey = deps.getMinimapImageKey(mapX, mapY, level);
    const pixelsPerTile = Math.max(
        1,
        Math.min(8, Math.ceil(state.worldMapState.getZoomScale?.() ?? 1)),
    );
    const areaId = Math.max(0, state.worldMapState.getCurrentMapAreaId() | 0) & 0x1ff;
    return baseKey | ((pixelsPerTile & 0xf) << 18) | (areaId << 22);
}

function updateWorldMapImageRequestEpoch(state: WorldMapStateHolder, deps: WorldMapImageDeps): number {
    const zoomBucket = Math.max(1, Math.round((state.worldMapState.zoomPercentage || 100) / 25));
    const viewportKey = [
        state.worldMapState.getCurrentMapAreaId(),
        (state.worldMapState.displayX | 0) >> 6,
        (state.worldMapState.displayY | 0) >> 6,
        zoomBucket,
        (state.worldMapState.displayWidth | 0) >> 6,
        (state.worldMapState.displayHeight | 0) >> 6,
    ].join(":");
    if (viewportKey !== state.worldMapImageRequestViewportKey) {
        state.worldMapImageRequestViewportKey = viewportKey;
        state.worldMapImageRequestEpoch = (state.worldMapImageRequestEpoch + 1) | 0;
        state.failedWorldMapImageIds.clear();
        deps.cancelTileLoads?.();
        state.pendingWorldMapImageIds.clear();
    }
    return state.worldMapImageRequestEpoch;
}

function rememberFailedWorldMapImage(state: WorldMapStateHolder, mapId: number): void {
    if (state.failedWorldMapImageIds.has(mapId)) return;
    const limit = getFailedWorldMapIdLimit();
    while (state.failedWorldMapImageIds.size >= limit) {
        const first = state.failedWorldMapImageIds.keys().next().value;
        if (first === undefined) break;
        state.failedWorldMapImageIds.delete(first);
    }
    state.failedWorldMapImageIds.set(mapId, performance.now());
}

function hasRecentlyFailedWorldMapImage(state: WorldMapStateHolder, mapId: number): boolean {
    const failedAt = state.failedWorldMapImageIds.get(mapId);
    if (failedAt === undefined) return false;
    if (performance.now() - failedAt < WORLDMAP_TILE_RETRY_MS) return true;
    state.failedWorldMapImageIds.delete(mapId);
    return false;
}

function invalidateWorldMapIconCacheForId(state: WorldMapStateHolder, mapId: number): void {
    state.worldMapIconCache.delete(mapId);
}

function isWorldMapImageIcon(icon: unknown): icon is MinimapIcon {
    if (!icon || typeof icon !== "object") return false;
    const candidate = icon as MinimapIcon;
    if (
        !Number.isInteger(candidate.localX) ||
        candidate.localX < 0 ||
        candidate.localX >= 64 ||
        !Number.isInteger(candidate.localY) ||
        candidate.localY < 0 ||
        candidate.localY >= 64 ||
        !Number.isSafeInteger(candidate.elementId) ||
        candidate.elementId < 0 ||
        !Number.isSafeInteger(candidate.category) ||
        !Number.isSafeInteger(candidate.spriteId)
    ) {
        return false;
    }
    for (const key of [
        "textColor",
        "textSize",
        "horizontalAlignment",
        "verticalAlignment",
        "sourcePlane",
        "sourceX",
        "sourceY",
        "displayPlane",
        "displayX",
        "displayY",
    ] as const) {
        const value = candidate[key];
        if (value !== undefined && !Number.isSafeInteger(value)) return false;
    }
    for (const key of ["sourcePlane", "displayPlane"] as const) {
        const plane = candidate[key];
        if (plane !== undefined && (plane < 0 || plane > 3)) return false;
    }
    for (const key of ["sourceX", "sourceY", "displayX", "displayY"] as const) {
        const coord = candidate[key];
        if (coord !== undefined && (coord < 0 || coord > 0x3fff)) return false;
    }
    return (
        (candidate.worldMapVisible === undefined || typeof candidate.worldMapVisible === "boolean") &&
        (candidate.name === undefined || typeof candidate.name === "string")
    );
}

export function clearWorldMapIconCache(state: WorldMapStateHolder): void {
    state.worldMapIconCache.clear();
    state.worldMapIconCacheAreaId = state.worldMapState.getCurrentMapAreaId();
}

function releaseWorldMapImageTile(deps: WorldMapImageDeps, tile: { key: string }): void {
    deps.evictTextureKey(tile.key);
}

function clearWorldMapIconsForImageKey(
    state: WorldMapStateHolder,
    mapId: number,
): void {
    const tileKey = mapId & ~0x3c0000;
    for (const id of state.worldMapImageTiles.keys()) {
        if (id !== mapId && (id & ~0x3c0000) === tileKey) {
            invalidateWorldMapIconCacheForId(state, mapId);
            return;
        }
    }
    const level = (mapId >>> 16) & 0x3;
    const mapSquare = mapId & 0xffff;
    const areaId = (mapId >>> 22) & 0x1ff;
    state.worldMapState.removeTileIcons(
        (mapSquare >>> 8) & 0xff,
        mapSquare & 0xff,
        level,
        areaId,
    );
    invalidateWorldMapIconCacheForId(state, mapId);
}

function pruneWorldMapImages(state: WorldMapStateHolder, deps: WorldMapImageDeps): void {
    const limit = getWorldMapImageLimit();
    const retainedLimit = Math.max(limit, state.retainedWorldMapImageIds.size);
    const loadedCount = state.worldMapImageTiles.size;
    if (loadedCount <= retainedLimit) return;
    const ids = Array.from(state.worldMapImageTiles.keys());
    ids.sort(
        (a, b) =>
            (state.worldMapImageAccess.get(a) ?? -Infinity) -
            (state.worldMapImageAccess.get(b) ?? -Infinity),
    );
    const removableIds = ids.filter((id) => !state.retainedWorldMapImageIds.has(id));
    const toRemove = removableIds.slice(0, loadedCount - retainedLimit);
    for (const id of toRemove) {
        const tile = state.worldMapImageTiles.get(id);
        if (tile) {
            releaseWorldMapImageTile(deps, tile);
        }
        state.worldMapImageTiles.delete(id);
        state.worldMapImageAccess.delete(id);
        clearWorldMapIconsForImageKey(state, id);
    }
}

function setWorldMapImageTile(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    mapX: number,
    mapY: number,
    pixels: Uint8Array,
    width: number,
    height: number,
    level: number,
    icons: MinimapIcon[],
): void {
    const mapId = getWorldMapImageKey(state, deps, mapX, mapY, level);
    const oldTile = state.worldMapImageTiles.get(mapId);
    if (oldTile) {
        releaseWorldMapImageTile(deps, oldTile);
        state.worldMapImageTiles.delete(mapId);
        state.worldMapImageAccess.delete(mapId);
    }
    state.worldMapImageTiles.set(mapId, {
        key: `worldmap:${mapId}:${state.worldMapImageCacheEpoch}`,
        pixels,
        width: width | 0,
        height: height | 0,
    });
    state.worldMapImageAccess.set(mapId, performance.now());
    state.worldMapState.setTileIcons(mapX | 0, mapY | 0, level | 0, icons);
    invalidateWorldMapIconCacheForId(state, mapId);
    pruneWorldMapImages(state, deps);
    deps.scheduleRepaint();
}

function queueLoadWorldMapImage(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    mapX: number,
    mapY: number,
    level: number,
    cacheEpoch: number,
): void {
    const mapId = getWorldMapImageKey(state, deps, mapX, mapY, level);
    if (state.pendingWorldMapImageIds.has(mapId)) {
        return;
    }
    if (hasRecentlyFailedWorldMapImage(state, mapId)) {
        return;
    }
    if (state.worldMapImageTiles.has(mapId)) {
        return;
    }
    if (state.pendingWorldMapImageIds.size >= getWorldMapImagePendingLimit(state)) {
        return;
    }

    const archiveRenderer = deps.getWorldMapArchiveRenderer();
    const area = state.worldMapState.currentArea;
    const pixelsPerTile = Math.ceil(state.worldMapState.getZoomScale?.() ?? 1);
    if (!archiveRenderer) {
        rememberFailedWorldMapImage(state, mapId);
        return;
    }

    state.pendingWorldMapImageIds.add(mapId);
    const requestEpoch = state.worldMapImageRequestEpoch;
    const current = () => cacheEpoch === state.worldMapImageCacheEpoch && requestEpoch === state.worldMapImageRequestEpoch;
    void Promise.resolve()
        .then(() => current() ? archiveRenderer.loadTile(area, mapX | 0, mapY | 0, pixelsPerTile) : undefined)
        .then((tile) => {
            if (!current()) {
                return;
            }
            if (mapId !== getWorldMapImageKey(state, deps, mapX, mapY, level)) {
                return;
            }
            const tileWidth = tile?.width;
            const tileHeight = tile?.height;
            if (
                tile?.pixels instanceof Uint8Array &&
                typeof tileWidth === "number" &&
                typeof tileHeight === "number" &&
                Number.isSafeInteger(tileWidth) &&
                Number.isSafeInteger(tileHeight) &&
                tileWidth > 0 &&
                tileHeight > 0 &&
                tile.pixels.length >= tileWidth * tileHeight * 4
            ) {
                setWorldMapImageTile(
                    state,
                    deps,
                    mapX | 0,
                    mapY | 0,
                    tile.pixels,
                    tileWidth | 0,
                    tileHeight | 0,
                    level | 0,
                    Array.isArray(tile.icons) ? tile.icons.filter(isWorldMapImageIcon) : [],
                );
                return;
            }
            rememberFailedWorldMapImage(state, mapId);
        })
        .catch((err) => {
            if (!current()) {
                return;
            }
            console.log("[WorldMapController] Failed to load world map image tile", {
                mapX,
                mapY,
                level,
                err,
            });
            rememberFailedWorldMapImage(state, mapId);
        })
        .finally(() => {
            if (current()) state.pendingWorldMapImageIds.delete(mapId);
        });
}

function getWorldMapImageSourceInternal(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    mapX: number,
    mapY: number,
    level: number,
    accessPriority: number,
): WorldMapImageTile | undefined {
    updateWorldMapImageRequestEpoch(state, deps);
    const mapId = getWorldMapImageKey(state, deps, mapX, mapY, level);
    const accessTime = performance.now() + Math.max(0, accessPriority);
    const tile = state.worldMapImageTiles.get(mapId);
    if (tile) {
        state.worldMapImageAccess.set(mapId, accessTime);
        return tile;
    }
    queueLoadWorldMapImage(state, deps, mapX, mapY, level, state.worldMapImageCacheEpoch);
    return undefined;
}

export function getWorldMapImageTile(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    mapX: number,
    mapY: number,
    level: number = 0,
    accessPriority: number = 0,
): WorldMapImageTile | undefined {
    if (mapX < 0 || mapY < 0 || mapX >= MapManager.MAX_MAP_X || mapY >= MapManager.MAX_MAP_Y) {
        return undefined;
    }
    return getWorldMapImageSourceInternal(state, deps, mapX, mapY, level, accessPriority);
}

export function getWorldMapImageSource(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    mapX: number,
    mapY: number,
    level: number = 0,
    accessPriority: number = 0,
): WorldMapImageTile | undefined {
    if (mapX < 0 || mapY < 0 || mapX >= MapManager.MAX_MAP_X || mapY >= MapManager.MAX_MAP_Y) {
        return undefined;
    }
    return getWorldMapImageSourceInternal(state, deps, mapX, mapY, level, accessPriority);
}

export function markWorldMapImageTextureUploaded(
    state: WorldMapStateHolder,
    key: string,
): void {
    for (const tile of state.worldMapImageTiles.values()) {
        if (tile.key === key) {
            delete tile.pixels;
            return;
        }
    }
}

export function retainWorldMapImageTiles(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    tiles: WorldMapRetainTile[],
): void {
    const retained = new Set<number>();
    for (const tile of tiles) {
        const retainedTile = tile.sourceTile ?? tile;
        const mapX = retainedTile.mapX | 0;
        const mapY = retainedTile.mapY | 0;
        if (
            mapX < 0 ||
            mapY < 0 ||
            mapX >= MapManager.MAX_MAP_X ||
            mapY >= MapManager.MAX_MAP_Y
        ) {
            continue;
        }
        retained.add(getWorldMapImageKey(state, deps, mapX, mapY, retainedTile.level ?? 0));
    }
    state.retainedWorldMapImageIds = retained;
    pruneWorldMapImages(state, deps);
}

export function clearWorldMapImages(
    state: WorldMapStateHolder,
    deps: WorldMapImageDeps,
    clearIconCache: () => void,
    clearRenderCaches: () => void,
): void {
    state.worldMapImageCacheEpoch = (state.worldMapImageCacheEpoch + 1) | 0;
    deps.cancelTileLoads?.(true);
    for (const tile of state.worldMapImageTiles.values()) {
        releaseWorldMapImageTile(deps, tile);
    }
    state.worldMapImageTiles.clear();
    state.worldMapImageAccess.clear();
    state.worldMapState.clearTileIcons();
    clearIconCache();
    clearRenderCaches();
    state.pendingWorldMapImageIds.clear();
    state.failedWorldMapImageIds.clear();
    state.retainedWorldMapImageIds.clear();
    state.worldMapImageRequestViewportKey = "";
    state.worldMapImageRequestEpoch = 0;
    deps.scheduleRepaint();
}

export { scheduleWorldMapImageRepaint } from "./WorldMapRepaint";
