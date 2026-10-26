import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged } from "@runelite/api/events";
import type { ConfigOf } from "@runelite/client/config/ConfigItem";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { ChatboxPanelManager } from "@runelite/client/game/chatbox/ChatboxPanelManager";
import { MenuManager } from "@runelite/client/menus/MenuManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { MenuTargetType } from "../../../rs/MenuEntry";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { MenuTransformContext } from "../../../ui/menu/menuTransforms";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import {
    fromLocalInstance,
    fromRegion,
    regionIdOf,
    regionLocal,
    sceneRegionIds,
    toLocalInstance,
    type InstanceScene,
    type WorldPoint,
} from "../../scene/worldPoint";
import type { WidgetOverlay } from "../ClientPluginManager";
import { prependColorTag } from "../npcindicators/npcMatching";
import { GroundMarkerConfig, SHOW_IMPORT_EXPORT_KEY_NAME } from "./GroundMarkerConfig";
import { GroundMarkerMinimapOverlay, GroundMarkerOverlay } from "./GroundMarkerOverlay";
import { REGION_PREFIX, parsePoints, samePoint, serializePoints, type GroundMarkerPoint } from "./groundMarkerPoints";
import { GroundMarkerSharingManager } from "./GroundMarkerSharingManager";

const CONFIG_GROUP = GroundMarkerConfig.group;

/** RuneLite's ColorTileMarker: a marked tile at a loaded scene tile. */
export type ColorTileMarker = { worldPoint: WorldPoint; color?: number; label?: string };

/**
 * RuneLite 1.13.3 Ground Markers: Shift + right-click a tile's "Walk here" to mark it, label it
 * and colour it; marks are saved per region, and the world map orb's menu exports, imports and
 * clears them as JSON.
 */
export class GroundMarkerPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Ground Markers",
        description: "Enable marking of tiles using the Shift key",
        tags: ["overlay", "tiles"],
        configKey: "groundmarkerplugin",
    };

    static config = GroundMarkerConfig;

    private readonly configManager: ConfigManager;
    readonly config: ConfigOf<typeof GroundMarkerConfig>;
    readonly chatboxPanelManager: ChatboxPanelManager;
    readonly menuManager: MenuManager;
    private readonly osrsClient: OsrsClient;
    readonly sharingManager: GroundMarkerSharingManager;
    private readonly overlays: WidgetOverlay[];
    /** The marked tiles in the loaded regions (RuneLite's points multimap). */
    points: ColorTileMarker[] = [];
    private sceneKey = "";
    private sceneTemplates: InstanceScene["templates"] = null;

    constructor(osrsClient?: OsrsClient, deps?: { configManager?: ConfigManager; chatboxPanelManager?: ChatboxPanelManager; menuManager?: MenuManager }) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.configManager = deps?.configManager ?? inject(ConfigManager);
        this.chatboxPanelManager = deps?.chatboxPanelManager ?? inject(ChatboxPanelManager);
        this.menuManager = deps?.menuManager ?? inject(MenuManager);
        this.config = this.configManager.getConfig(GroundMarkerConfig);
        this.sharingManager = new GroundMarkerSharingManager(this);
        this.overlays = [new GroundMarkerOverlay(this), new GroundMarkerMinimapOverlay(this)];
    }

    widgetOverlays(): WidgetOverlay[] {
        return this.isStarted() ? this.overlays : [];
    }

    protected async startUp(): Promise<void> {
        if (this.config.showImportExport()) {
            this.sharingManager.addImportExportMenuOptions();
            this.sharingManager.addClearMenuOption();
        }
        this.loadPoints();
    }

    protected async shutDown(): Promise<void> {
        this.sharingManager.removeMenuOptions();
        this.points = [];
        this.sceneKey = "";
        this.sceneTemplates = null;
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() === CONFIG_GROUP && event.getKey() === SHOW_IMPORT_EXPORT_KEY_NAME) {
            this.sharingManager.removeMenuOptions();
            if (this.config.showImportExport()) {
                this.sharingManager.addImportExportMenuOptions();
                this.sharingManager.addClearMenuOption();
            }
        }
    }

    /** Reload on region or instance-template replacement, as WorldViewLoaded would. */
    onGameTick(): void {
        if (this.currentSceneKey() !== this.sceneKey || this.instanceScene().templates !== this.sceneTemplates) this.loadPoints();
    }

    // ------------------------------------------------------------------ storage

    savePoints(regionId: number, points: readonly GroundMarkerPoint[] | null): void {
        if (!points || points.length === 0) {
            this.configManager.unsetConfiguration(CONFIG_GROUP, REGION_PREFIX + regionId);
            return;
        }
        this.configManager.setConfiguration(CONFIG_GROUP, REGION_PREFIX + regionId, serializePoints(points));
    }

    getPoints(regionId: number): GroundMarkerPoint[] {
        const json = this.configManager.getConfiguration(CONFIG_GROUP, REGION_PREFIX + regionId);
        try {
            return parsePoints(json);
        } catch (error) {
            console.warn(`[ground-markers] region ${regionId} has malformed markers`, error);
            return [];
        }
    }

    /** loadPoints: every saved point in the loaded regions, at each of its scene tiles. */
    loadPoints(): void {
        this.sceneKey = this.currentSceneKey();
        const scene = this.instanceScene();
        this.sceneTemplates = scene.templates;
        const points: ColorTileMarker[] = [];
        if (this.sceneKey) {
            for (const regionId of this.getMapRegions()) {
                for (const point of this.getPoints(regionId)) {
                    const template = fromRegion(point.regionId, point.regionX, point.regionY, point.z);
                    for (const worldPoint of toLocalInstance(scene, template)) {
                        points.push({ worldPoint, color: point.color, label: point.label });
                    }
                }
            }
        }
        this.points = points;
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

    /** client.getMapRegions: an instance's template regions, else the regions the scene covers. */
    getMapRegions(): number[] {
        return [...sceneRegionIds(this.instanceScene())];
    }

    private currentSceneKey(): string {
        if (!this.isStarted() || !this.isLoggedIn()) return "";
        const regions = this.getMapRegions().sort((a, b) => a - b).join(",");
        return ClientState.inInstance ? `i${ClientState.baseX},${ClientState.baseY}:${regions}` : regions;
    }

    // ------------------------------------------------------------------ menu

    /**
     * onMenuEntryAdded: with Shift held, Mark/Unmark, Label and Color for the tile under "Walk here".
     * Not with Ctrl too: Ctrl+Shift+click is the staff teleport, which needs "Walk here" on top.
     */
    transformMenuEntries(entries: SimpleMenuEntry[], context: MenuTransformContext): SimpleMenuEntry[] {
        if (context.surface !== "world" || !this.isStarted() || !ClientState.isShiftPressed()) return entries;
        if (ClientState.isCtrlPressed()) return entries;
        const walkIndex = entries.findIndex((e) => e.option === "Walk here");
        if (walkIndex < 0) return entries;
        const walk = entries[walkIndex];
        if (walk.mapX === undefined || walk.mapY === undefined) return entries;
        const sceneTile = { x: ClientState.baseX + walk.mapX, y: ClientState.baseY + walk.mapY, plane: this.playerPlane() };
        const worldPoint = fromLocalInstance(this.instanceScene(), sceneTile);
        const regionId = regionIdOf(worldPoint.x, worldPoint.y);
        const regionPoints = this.getPoints(regionId);
        const here: GroundMarkerPoint = { regionId, regionX: regionLocal(worldPoint.x), regionY: regionLocal(worldPoint.y), z: worldPoint.plane };
        const existing = regionPoints.find((p) => samePoint(p, here));

        const added: SimpleMenuEntry[] = [
            this.entry(existing ? "Unmark" : "Mark", () => this.markTile(worldPoint)),
        ];
        if (existing) {
            added.push(this.entry("Label", () => this.labelTile(existing)));
            const color = this.entry("Color", () => {});
            color.onClick = undefined;
            const submenu: SimpleMenuEntry[] = [];
            // RuneLite adds each submenu entry at the top, so they show in reverse.
            const add = (entry: SimpleMenuEntry) => submenu.unshift(entry);
            if (regionPoints.length > 1) {
                add({ option: "Reset all", target: "", onClick: () => this.promptResetAll(regionId, regionPoints) });
            }
            add({ option: "Pick", target: "", onClick: () => this.pickColor(existing) });
            const existingColors: number[] = [];
            for (const point of this.points) {
                if (point.color !== undefined && !existingColors.includes(point.color)) existingColors.push(point.color);
            }
            for (const c of existingColors) {
                if (c !== existing.color) add({ option: prependColorTag("Color", c), target: "", onClick: () => this.colorTile(existing, c) });
            }
            color.subEntries = submenu;
            added.push(color);
        }
        return [...entries.slice(0, walkIndex), ...added, ...entries.slice(walkIndex)];
    }

    private entry(option: string, onClick: () => void): SimpleMenuEntry {
        return { option, target: "Tile", targetType: MenuTargetType.NONE, onClick };
    }

    markTile(worldPoint: WorldPoint): void {
        const regionId = regionIdOf(worldPoint.x, worldPoint.y);
        const point: GroundMarkerPoint = {
            regionId,
            regionX: regionLocal(worldPoint.x),
            regionY: regionLocal(worldPoint.y),
            z: worldPoint.plane,
            color: Number(this.config.markerColor()) >>> 0,
        };
        const points = [...this.getPoints(regionId)];
        const at = points.findIndex((p) => samePoint(p, point));
        if (at >= 0) points.splice(at, 1);
        else points.push(point);
        this.savePoints(regionId, points);
        this.loadPoints();
    }

    private labelTile(existing: GroundMarkerPoint): void {
        this.chatboxPanelManager.openTextInput("Tile label")
            .value(existing.label ?? "")
            .onDone((input: string) => {
                const label = input === "" ? undefined : input;
                const points = this.getPoints(existing.regionId).filter((p) => !samePoint(p, existing));
                points.push({ ...existing, label });
                this.savePoints(existing.regionId, points);
                this.loadPoints();
            })
            .build();
    }

    colorTile(existing: GroundMarkerPoint, color: number): void {
        const newPoint = { ...existing, color: color >>> 0 };
        const points = this.getPoints(existing.regionId).filter((p) => !samePoint(p, newPoint));
        points.push(newPoint);
        this.savePoints(existing.regionId, points);
        this.loadPoints();
    }

    private promptResetAll(regionId: number, regionPoints: GroundMarkerPoint[]): void {
        this.chatboxPanelManager.openTextMenuInput(`Are you sure you want to reset the color of ${regionPoints.length} tiles?`)
            .option("Yes", () => {
                const markerColor = Number(this.config.markerColor()) >>> 0;
                this.savePoints(regionId, regionPoints.map((p) => ({ ...p, color: markerColor })));
                this.loadPoints();
            })
            .option("No", () => {})
            .build();
    }

    /** RuneLite opens its colour picker ("Tile marker color"); here it is the browser's, keeping alpha. */
    private pickColor(existing: GroundMarkerPoint): void {
        if (typeof document === "undefined") return;
        document.querySelectorAll("input[data-ground-marker-picker]").forEach((old) => old.remove());
        const current = existing.color ?? (Number(this.config.markerColor()) >>> 0);
        const input = document.createElement("input");
        input.type = "color";
        input.dataset.groundMarkerPicker = "";
        input.title = "Tile marker color";
        input.value = `#${(current & 0xffffff).toString(16).padStart(6, "0")}`;
        Object.assign(input.style, { position: "fixed", left: "-100px", top: "0", opacity: "0", pointerEvents: "none" });
        input.addEventListener("change", () => {
            const rgb = parseInt(input.value.slice(1), 16);
            if (Number.isInteger(rgb)) this.colorTile(existing, ((current & 0xff000000) | rgb) >>> 0);
            input.remove();
        }, { once: true });
        input.addEventListener("blur", () => setTimeout(() => input.remove(), 0), { once: true });
        document.body.appendChild(input);
        try {
            input.showPicker();
        } catch {
            input.click();
        }
    }
}
