import type { CacheSystem } from "../../rs/cache/CacheSystem";
import type { CacheLoaderFactory } from "../../rs/cache/loader/CacheLoaderFactory";
import type { LocTypeLoader } from "../../rs/config/loctype/LocTypeLoader";
import type { MapElementTypeLoader } from "../../rs/config/meltype/MapElementTypeLoader";
import type { VarManager } from "../../rs/config/vartype/VarManager";
import type { Cs2Vm } from "../../rs/cs2/Cs2Vm";
import type { Script as Cs2Script } from "../../rs/cs2/Script";
import { WorldMapArchiveRenderer } from "../../rs/map/WorldMapArchiveRenderer";
import type { RenderDataWorkerPool } from "../worker/RenderDataWorkerPool";
import { WorldMapState } from "../../rs/map/WorldMapArea";
import type { TextureLoader } from "../../rs/texture/TextureLoader";
import type { SimpleMenuEntry } from "../../ui/menu/MenuEngine";
import type { MinimapIcon } from "../../render/loader/SdMapData";
import {
    applyPendingWorldMapDrag,
    handleWorldMapDragInput,
    resetWorldMapClick,
    resetWorldMapDrag,
} from "./WorldMapInput";
import {
    clearWorldMapIconCache as clearIconCache,
    clearWorldMapImages as clearImages,
    getWorldMapImageKey,
    getWorldMapImageSource,
    getWorldMapImageTile,
    markWorldMapImageTextureUploaded as markTextureUploaded,
    retainWorldMapImageTiles as retainTiles,
    scheduleWorldMapImageRepaint,
    type WorldMapImageDeps,
} from "./WorldMapImageCache";
import { getWorldMapIcons as getIcons } from "./WorldMapTileIcons";
import { findWorldMapWidgetForRepaint } from "./WorldMapRepaint";
import {
    clearWorldMapRenderCaches,
    getWorldMapMenuEntriesAt as getMenuEntriesAt,
    updateWorldMapIconHover as updateIconHover,
    type WorldMapIconDeps,
} from "./WorldMapIconInteraction";
import type { WorldMapImageTile, WorldMapRenderedIcon, WorldMapRetainTile, WorldMapCitizenDot } from "./WorldMapTypes";

export type WorldMapControllerDeps = {
    getCacheSystem: () => CacheSystem;
    getLoaderFactory: () => CacheLoaderFactory;
    getLocTypeLoader: () => LocTypeLoader;
    getMapElementTypeLoader: () => MapElementTypeLoader | undefined;
    getTextureLoader: () => TextureLoader;
    getVarManager: () => VarManager | undefined;
    getWorkerPool?: () => RenderDataWorkerPool | undefined;
    getWidgetManager: () => any;
    getCs2Vm: () => Cs2Vm | undefined;
    getRenderer: () => { canvas?: any } | undefined;
    getMinimapImageKey: (mapX: number, mapY: number, level?: number) => number;
    loadClientScriptIfExists: (scriptId: number) => Cs2Script | null;
    clearHostRenderCaches: () => void;
};

/**
 * Client-side world map state, tile cache, input, and icon interaction.
 */
export class WorldMapController {
    worldMapState: WorldMapState = WorldMapState.empty();

    worldMapDragStartMouseX: number = -1;
    worldMapDragStartMouseY: number = -1;
    worldMapDragStartDisplayX: number = 0;
    worldMapDragStartDisplayY: number = 0;
    worldMapDragPixelsPerTileX: number = 1;
    worldMapDragPixelsPerTileY: number = 1;
    worldMapClickStartMouseX: number = -1;
    worldMapClickStartMouseY: number = -1;
    worldMapClickStartTimeMs: number = 0;
    pendingWorldMapDragDisplayX: number | undefined;
    pendingWorldMapDragDisplayY: number | undefined;

    private worldMapArchiveRenderer?: Pick<WorldMapArchiveRenderer, "loadTile">;
    private fallbackArchiveRenderer?: WorldMapArchiveRenderer;
    worldMapImageTiles: Map<number, WorldMapImageTile> = new Map();
    worldMapImageAccess: Map<number, number> = new Map();
    pendingWorldMapImageIds: Set<number> = new Set();
    failedWorldMapImageIds: Map<number, number> = new Map();
    retainedWorldMapImageIds: Set<number> = new Set();
    worldMapImageRequestViewportKey: string = "";
    worldMapImageRequestEpoch: number = 0;
    worldMapImageCacheEpoch: number = 0;
    worldMapIconCache: Map<number, MinimapIcon[] | undefined> = new Map();
    worldMapIconCacheAreaId: number = -2;
    worldMapImageRepaintQueued: boolean = false;
    worldMapWidgetUid: number = -1;
    renderedWorldMapIcons: WorldMapRenderedIcon[] = [];
    renderedCitizenDots: WorldMapCitizenDot[] = [];
    hoveredWorldMapIcons: Map<string, WorldMapRenderedIcon> = new Map();

    private readonly iconDeps: WorldMapIconDeps;
    private readonly imageDeps: WorldMapImageDeps;

    constructor(private readonly deps: WorldMapControllerDeps) {
        this.iconDeps = {
            loadClientScriptIfExists: (scriptId) => this.deps.loadClientScriptIfExists(scriptId),
            loadMapElement: (elementId) => this.deps.getMapElementTypeLoader()?.load?.(elementId | 0),
            runCs2Script: (script, intArgs) => {
                this.deps.getCs2Vm()?.run(script, intArgs);
            },
            invalidateAllWidgets: () => this.deps.getWidgetManager()?.invalidateAll?.(),
        };
        this.imageDeps = {
            getMinimapImageKey: (mapX, mapY, level) =>
                this.deps.getMinimapImageKey(mapX, mapY, level),
            getWorldMapArchiveRenderer: () => this.worldMapArchiveRenderer,
            cancelTileLoads: (clearCache) => {
                this.deps.getWorkerPool?.()?.cancelWorldMapTiles(clearCache);
                if (clearCache) this.fallbackArchiveRenderer?.clear();
                else this.fallbackArchiveRenderer?.cancelLoads();
            },
            loadMapElement: (elementId) => this.deps.getMapElementTypeLoader()?.load?.(elementId | 0),
            getWidgetManager: () => this.deps.getWidgetManager(),
            evictTextureKey: (key) => {
                const textureCache = this.deps.getRenderer()?.canvas?.__textureCache;
                if (textureCache && typeof textureCache.evictTextureKey === "function") {
                    try {
                        textureCache.evictTextureKey(key);
                    } catch {}
                }
            },
            scheduleRepaint: () => this.scheduleRepaint(),
        };
    }

    setWorldMapState(state: WorldMapState): void {
        this.clearWorldMapImages();
        state.setElementMetadataResolver((elementId) => {
            try {
                const element = this.deps.getMapElementTypeLoader()?.load?.(elementId | 0);
                return element ? { category: element.category | 0 } : undefined;
            } catch {
                return undefined;
            }
        });
        this.worldMapState = state;
        clearIconCache(this);
        this.clearRenderCaches();
        resetWorldMapDrag(this);
        resetWorldMapClick(this);
        this.pendingWorldMapDragDisplayX = undefined;
        this.pendingWorldMapDragDisplayY = undefined;
        const cs2Vm = this.deps.getCs2Vm();
        if (cs2Vm?.context) {
            cs2Vm.context.worldMapState = state;
        }
    }

    initArchiveRenderer(): void {
        this.deps.getWorkerPool?.()?.cancelWorldMapTiles(true);
        this.fallbackArchiveRenderer?.clear();
        this.fallbackArchiveRenderer = undefined;
        this.worldMapArchiveRenderer = {
            loadTile: async (area, mapX, mapY, pixelsPerTile) => {
                if (!area) return undefined;
                const pool = this.deps.getWorkerPool?.();
                if (pool) {
                    const { id, internalName, backgroundColor, regionLowX, regionHighX, regionLowY, regionHighY } = area;
                    const reply = await pool.loadWorldMapTile({
                        area: { id, internalName, backgroundColor, regionLowX, regionHighX, regionLowY, regionHighY },
                        mapX, mapY, pixelsPerTile,
                    });
                    if (reply.supported) return reply.tile;
                }
                // Older worker environments can still decode through a DOM image/canvas.
                this.fallbackArchiveRenderer ??= this.createFallbackRenderer();
                return this.fallbackArchiveRenderer?.loadTile(area, mapX, mapY, pixelsPerTile);
            },
        };
    }

    private createFallbackRenderer(): WorldMapArchiveRenderer | undefined {
        try {
            let mapScenes: ReturnType<CacheLoaderFactory["getMapScenes"]> = [];
            try {
                mapScenes = this.deps.getLoaderFactory().getMapScenes();
            } catch (error) {
                console.log("[WorldMapController] Failed to load world map scene sprites", { error });
            }
            return new WorldMapArchiveRenderer({
                cacheSystem: this.deps.getCacheSystem(),
                locTypeLoader: this.deps.getLocTypeLoader(),
                mapElementTypeLoader: this.deps.getMapElementTypeLoader(),
                overlayTypeLoader: this.deps.getLoaderFactory().getOverlayTypeLoader(),
                textureLoader: this.deps.getTextureLoader(),
                mapScenes,
                varManager: this.deps.getVarManager(),
                maxRenderedRegionBytes: 0,
            });
        } catch (error) {
            console.log("[WorldMapController] Failed to initialise world map archive renderer", {
                error,
            });
            return undefined;
        }
    }

    setRenderedWorldMapIcons(icons: WorldMapRenderedIcon[]): void {
        this.renderedWorldMapIcons = Array.isArray(icons) ? icons : [];
    }

    setRenderedCitizenDots(dots: WorldMapCitizenDot[]): void {
        this.renderedCitizenDots = Array.isArray(dots) ? dots : [];
    }

    updateWorldMapIconHover(screenX: number, screenY: number): void {
        updateIconHover(this, this.iconDeps, screenX, screenY);
    }

    getWorldMapMenuEntriesAt(screenX: number, screenY: number): SimpleMenuEntry[] {
        return getMenuEntriesAt(this, this.iconDeps, screenX, screenY);
    }

    handleWorldMapDragInput(
        hits: any[],
        mouseX: number,
        mouseY: number,
        isNewClick: boolean,
        isHolding: boolean,
    ): boolean {
        return handleWorldMapDragInput(this, {
            isWidgetEffectivelyHidden: (uid) =>
                !!this.deps.getWidgetManager()?.isEffectivelyHidden?.(uid),
            invalidateAllWidgets: () => this.deps.getWidgetManager()?.invalidateAll?.(),
        }, hits, mouseX, mouseY, isNewClick, isHolding);
    }

    applyPendingWorldMapDrag(): boolean {
        return applyPendingWorldMapDrag(this, () =>
            this.deps.getWidgetManager()?.invalidateAll?.(),
        );
    }

    cycle(): boolean {
        return !!this.worldMapState?.cycle?.();
    }

    hasPendingImages(): boolean {
        return this.pendingWorldMapImageIds.size > 0 || (this.deps.getWorkerPool?.()?.pendingWorldMapTiles ?? 0) > 0;
    }

    getWorldMapImageTile(
        mapX: number,
        mapY: number,
        level: number = 0,
        accessPriority: number = 0,
    ): WorldMapImageTile | undefined {
        return getWorldMapImageTile(this, this.imageDeps, mapX, mapY, level, accessPriority);
    }

    getWorldMapImageSource(
        mapX: number,
        mapY: number,
        level: number = 0,
        accessPriority: number = 0,
    ): WorldMapImageTile | undefined {
        return getWorldMapImageSource(this, this.imageDeps, mapX, mapY, level, accessPriority);
    }

    markWorldMapImageTextureUploaded(key: string): void {
        markTextureUploaded(this, key);
    }

    getWorldMapIcons(mapX: number, mapY: number, level: number = 0): MinimapIcon[] | undefined {
        return getIcons(this, this.imageDeps, mapX, mapY, level);
    }

    retainWorldMapImageTiles(tiles: WorldMapRetainTile[]): void {
        retainTiles(this, this.imageDeps, tiles);
    }

    clearWorldMapImages(): void {
        clearImages(
            this,
            this.imageDeps,
            () => clearIconCache(this),
            () => this.clearRenderCaches(),
        );
    }

    private clearRenderCaches(): void {
        clearWorldMapRenderCaches(this, () => this.deps.clearHostRenderCaches());
    }

    private scheduleRepaint(): void {
        scheduleWorldMapImageRepaint(this, () => this.deps.getWidgetManager());
    }

    /** @internal Used by image cache for key derivation. */
    getWorldMapImageKey(mapX: number, mapY: number, level: number = 0): number {
        return getWorldMapImageKey(this, this.imageDeps, mapX, mapY, level);
    }

    /** @internal Used by repaint scheduling. */
    findWidgetForRepaint(): any | undefined {
        return findWorldMapWidgetForRepaint(this, () => this.deps.getWidgetManager());
    }
}

export type { WorldMapRenderedIcon, WorldMapRetainTile } from "./WorldMapTypes";
