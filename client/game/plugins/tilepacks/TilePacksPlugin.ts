import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged } from "@runelite/api/events";
import type { ConfigOf } from "@runelite/client/config/ConfigItem";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import type { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { chatHistory } from "../../../rs/cs2/ChatHistory";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import { fromRegion, sceneRegionIds, toLocalInstance, type InstanceScene, type WorldPoint } from "../../scene/worldPoint";
import type { WidgetOverlay } from "../ClientPluginManager";
import { indexByRegion, parseBundledPacks, type TilePack, type TilePackPoint } from "./tilePackData";
import { TilePackStore } from "./TilePackStore";
import { TilePacksConfig } from "./TilePacksConfig";
import { TilePacksMinimapOverlay, TilePacksOverlay } from "./TilePacksOverlay";
import { createTilePacksNavigationButton } from "./TilePacksPanel";

/** A pack tile at a loaded scene tile (Tile Packs' ColorTileMarker). */
export type ColorTileMarker = { point: WorldPoint; color?: number; label?: string };

/** The bundled packs, fetched once (500 KB, so kept out of the main bundle). */
let bundledPacks: Promise<Map<number, TilePack>> | undefined;

function loadBundledPacks(): Promise<Map<number, TilePack>> {
    bundledPacks ??= (async () => {
        const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
        const response = await fetch(`${base}/tilepacks/tilePacks.jsonc`);
        if (!response.ok) throw new Error(`tilePacks.jsonc: HTTP ${response.status}`);
        return parseBundledPacks(await response.text());
    })();
    bundledPacks.catch(() => (bundledPacks = undefined));
    return bundledPacks;
}

/**
 * The Plugin Hub's Tile Packs (TrevorMDev, BSD-2): ready-made sets of ground markers, turned on
 * and off from a sidebar panel, plus custom packs pasted in as ground marker JSON.
 */
export class TilePacksPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Tile Packs",
        description: "A collection of tile markers",
        tags: ["tile", "ground", "marker", "pack"],
        enabledByDefault: false,
        configKey: "tilepacksplugin",
    };

    static config = TilePacksConfig;

    private readonly configManager: ConfigManager;
    readonly config: ConfigOf<typeof TilePacksConfig>;
    readonly store: TilePackStore;
    private readonly osrsClient: OsrsClient;
    private readonly clientToolbar?: ClientToolbar;
    private navButton?: NavigationButton;
    private readonly overlays: WidgetOverlay[];
    /** Enabled packs' tiles by region (PointManager.activePointsByRegion), built on first use. */
    private activePointsByRegion?: Map<number, TilePackPoint[]>;
    /** The tiles to draw, for the loaded regions (PointManager.points). */
    points: ColorTileMarker[] = [];
    private sceneKey = "";
    private sceneTemplates: InstanceScene["templates"] = null;
    private loaded = false;
    private readonly listeners = new Set<() => void>();
    private version = 0;
    /** Set when the migration failed: the plugin then does nothing, as in Tile Packs. */
    failed = false;

    constructor(
        osrsClient?: OsrsClient,
        configManager?: ConfigManager,
        clientToolbar?: ClientToolbar,
        private readonly loadPacks: () => Promise<Map<number, TilePack>> = loadBundledPacks,
    ) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.configManager = configManager ?? inject(ConfigManager);
        this.clientToolbar = clientToolbar ?? (osrsClient ? undefined : inject(ClientToolbar));
        this.config = this.configManager.getConfig(TilePacksConfig);
        this.store = new TilePackStore(this.configManager);
        this.overlays = [new TilePacksOverlay(this), new TilePacksMinimapOverlay(this)];
    }

    widgetOverlays(): WidgetOverlay[] {
        return this.loaded ? this.overlays : [];
    }

    protected async startUp(): Promise<void> {
        this.failed = false;
        try {
            this.store.migrateToLatest();
        } catch (error) {
            console.error("[tile-packs] Unable to migrate Tile Packs configuration", error);
            chatHistory.addMessage("game", "Tile Packs failed to migrate to latest version. Please report this issue.");
            this.failed = true;
            return;
        }
        let bundled = new Map<number, TilePack>();
        try {
            bundled = await this.loadPacks();
        } catch (error) {
            console.error("[tile-packs] error loading packs from json, this is likely due to a bad json file.", error);
        }
        if (!this.isStarted()) return;
        this.store.load(bundled);
        this.loaded = true;
        this.loadPoints();
        this.navButton = createTilePacksNavigationButton(this);
        if (!this.config.hidePlugin()) this.clientToolbar?.addNavigation(this.navButton);
        this.commit();
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.clientToolbar?.removeNavigation(this.navButton);
        this.navButton = undefined;
        this.loaded = false;
        this.points = [];
        this.activePointsByRegion = undefined;
        this.sceneKey = "";
        this.sceneTemplates = null;
    }

    onConfigChanged(event: ConfigChanged): void {
        if (!this.loaded) return;
        if (event.getGroup() === TilePacksConfig.group) {
            if (event.getKey() === "hidePlugin" && this.navButton) {
                if (this.config.hidePlugin()) this.clientToolbar?.removeNavigation(this.navButton);
                else this.clientToolbar?.addNavigation(this.navButton);
            }
        } else {
            this.loadPoints();
        }
        this.commit();
    }

    /** Reload on region or instance-template replacement, as WorldViewLoaded would. */
    onGameTick(): void {
        if (!this.loaded) return;
        const key = this.currentSceneKey();
        if (key !== this.sceneKey || this.instanceScene().templates !== this.sceneTemplates) this.loadPoints();
    }

    // ------------------------------------------------------------------ scene facts

    getClient(): OsrsClient {
        return this.osrsClient;
    }

    isLoggedIn(): boolean {
        return toRuneLiteGameState((this.osrsClient as any)?.gameState) === GameState.LOGGED_IN;
    }

    private playerIndex(): number | undefined {
        const client: any = this.osrsClient;
        return client.playerEcs?.getIndexForServerId?.(client.controlledPlayerServerId);
    }

    playerPlane(): number {
        const index = this.playerIndex();
        return index === undefined ? ClientState.plane | 0 : (this.osrsClient as any).playerEcs.getLevel(index) | 0;
    }

    /** The local player's tile, or undefined before it exists. */
    playerTile(): WorldPoint | undefined {
        const index = this.playerIndex();
        if (index === undefined) return undefined;
        const players = (this.osrsClient as any).playerEcs;
        return { x: players.getX(index) >> 7, y: players.getY(index) >> 7, plane: players.getLevel(index) | 0 };
    }

    private instanceScene(): InstanceScene {
        return {
            templates: ClientState.inInstance ? ClientState.instanceTemplateChunks : null,
            baseX: ClientState.baseX,
            baseY: ClientState.baseY,
        };
    }

    /** WorldView.getMapRegions: an instance's template regions, else the regions the scene covers. */
    private mapRegions(): number[] {
        return [...sceneRegionIds(this.instanceScene())];
    }

    private currentSceneKey(): string {
        if (!this.isLoggedIn()) return "";
        const regions = this.mapRegions().sort((a, b) => a - b).join(",");
        return ClientState.inInstance ? `i${ClientState.baseX},${ClientState.baseY}:${regions}` : regions;
    }

    // ------------------------------------------------------------------ points

    /** PointManager.loadPoints: the enabled packs' tiles in the loaded regions, as scene tiles. */
    loadPoints(): void {
        this.activePointsByRegion = undefined;
        this.sceneKey = this.currentSceneKey();
        const scene = this.instanceScene();
        this.sceneTemplates = scene.templates;
        const points: ColorTileMarker[] = [];
        if (this.sceneKey) {
            for (const regionId of this.mapRegions()) {
                for (const tile of this.activePoints(regionId)) {
                    const template = fromRegion(tile.regionId, tile.regionX, tile.regionY, tile.z);
                    for (const point of toLocalInstance(scene, template)) {
                        points.push({ point, color: tile.color, label: tile.label });
                    }
                }
            }
        }
        this.points = points;
    }

    private activePoints(regionId: number): TilePackPoint[] {
        this.activePointsByRegion ??= indexByRegion(this.store.tilePacks, this.store.enabledPacks);
        return this.activePointsByRegion.get(regionId) ?? [];
    }

    // ------------------------------------------------------------------ panel

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Changes whenever the packs, filters or settings change, for the panel. */
    getVersion(): number {
        return this.version;
    }

    commit(): void {
        this.version++;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                console.log("[tile-packs] listener failed", error);
            }
        }
    }

    togglePack(pack: TilePack): void {
        if (this.store.isPackEnabled(pack.id)) this.store.removeEnabledPack(pack.id);
        else this.store.addEnabledPack(pack.id);
        this.loadPoints();
        this.commit();
    }

    toggleVisible(pack: TilePack): void {
        pack.visible = !pack.visible;
        this.store.updatePack(pack);
        this.commit();
    }

    setShowVisible(show: boolean): void {
        this.store.setShowVisible(show);
        this.commit();
    }

    setShowInvisible(show: boolean): void {
        this.store.setShowInvisible(show);
        this.commit();
    }

    addCustomPack(name: string, tiles: string): void {
        this.store.addCustomPack(name, tiles);
        this.loadPoints();
        this.commit();
    }

    removeCustomPack(pack: TilePack): void {
        this.store.removeCustomPack(pack.id);
        this.loadPoints();
        this.commit();
    }

    /** CopyToClipboardLabel: the pack's tiles to the clipboard, then a chat message. */
    async copyTiles(pack: TilePack): Promise<void> {
        try {
            await navigator.clipboard.writeText(pack.packTiles ?? "");
        } catch (error) {
            console.warn("[tile-packs] clipboard write failed", error);
            return;
        }
        chatHistory.addMessage("game", `${pack.packName} tiles copied to clipboard`);
    }
}
