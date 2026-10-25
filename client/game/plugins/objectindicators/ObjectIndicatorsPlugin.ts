import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import type { LocType } from "../../../rs/config/loctype/LocType";
import { MenuTargetType } from "../../../rs/MenuEntry";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { MenuTransformContext } from "../../../ui/menu/menuTransforms";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import type { SceneLoc } from "../../scene/SceneGeometry";
import {
    fromLocalInstance,
    fromRegion,
    regionIdOf,
    sceneRegionIds,
    toLocalInstance,
    type InstanceScene,
    type WorldPoint,
} from "../../scene/worldPoint";
import type { LocOutline } from "../ClientPluginManager";
import { ObjectIndicatorsConfig } from "./ObjectIndicatorsConfig";
import { ObjectIndicatorsOverlay } from "./ObjectIndicatorsOverlay";
import {
    HF_CLICKBOX,
    HF_HULL,
    HF_OUTLINE,
    HF_TILE,
    REGION_KEY_PREFIX,
    colorChoices,
    matchesPoint,
    objectTile,
    parsePoints,
    pointFlags,
    serializePoints,
    type ObjectPoint,
} from "./objectPoints";

const GROUP = ObjectIndicatorsConfig.group;
export const MARK = "Mark object";
export const UNMARK = "Unmark object";

/** A loaded object that matches a saved point (RuneLite's ColorTileObject). */
export type MarkedObject = { loc: SceneLoc; point: ObjectPoint };

/**
 * RuneLite 1.13.3 Object Markers (Object Indicators): Shift + right-click an object's Examine
 * to mark it; marked objects draw by hull, outline, clickbox and/or tile, with per-object
 * border and fill colours and styles, saved per region.
 */
export class ObjectIndicatorsPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Object Markers",
        description: "Enable marking of objects using the Shift key",
        tags: ["overlay", "objects", "mark", "marker"],
        enabledByDefault: false,
        configKey: "objectindicatorsplugin",
    };

    static config = ObjectIndicatorsConfig;

    private readonly configManager = inject(ConfigManager);
    readonly config = this.configManager.getConfig(ObjectIndicatorsConfig);
    private readonly osrsClient: OsrsClient;
    /** Saved points by region id. */
    readonly points = new Map<number, ObjectPoint[]>();
    /** Marked objects in the loaded scene, rebuilt every tick and after any change. */
    objects: MarkedObject[] = [];
    readonly widgetOverlay: ObjectIndicatorsOverlay;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.widgetOverlay = new ObjectIndicatorsOverlay(this);
    }

    protected async startUp(): Promise<void> {
        this.loadPoints();
        this.rebuild();
    }

    protected async shutDown(): Promise<void> {
        this.points.clear();
        this.objects = [];
    }

    onGameTick(): void {
        this.rebuild();
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() !== GROUP) return;
        if (String(event.getKey() ?? "").startsWith(REGION_KEY_PREFIX)) this.loadPoints();
        this.rebuild();
    }

    // ------------------------------------------------------------------ scene facts

    getClient(): OsrsClient {
        return this.osrsClient;
    }

    isLoggedIn(): boolean {
        return toRuneLiteGameState((this.osrsClient as any)?.gameState) === GameState.LOGGED_IN;
    }

    playerPlane(): number {
        const client: any = this.osrsClient;
        const players = client.playerEcs;
        const index = players?.getIndexForServerId?.(client.controlledPlayerServerId);
        return index === undefined ? ClientState.plane | 0 : players.getLevel(index) | 0;
    }

    private instanceScene(): InstanceScene {
        return {
            templates: ClientState.inInstance ? ClientState.instanceTemplateChunks : null,
            baseX: ClientState.baseX,
            baseY: ClientState.baseY,
        };
    }

    locType(id: number): LocType | undefined {
        try {
            return (this.osrsClient as any).locTypeLoader?.load(id);
        } catch {
            return undefined;
        }
    }

    /** RuneLite's getObjectComposition: a multiloc's current form, else the object itself. */
    composition(id: number): LocType | undefined {
        const type = this.locType(id);
        if (!type?.transforms) return type;
        const client: any = this.osrsClient;
        return type.transform(client.varManager, client.locTypeLoader) ?? undefined;
    }

    /** The tile RuneLite saves and matches for a loaded object. */
    objectTileOf(loc: SceneLoc): WorldPoint {
        const type = this.locType(loc.id);
        return objectTile({ x: loc.tileX, y: loc.tileY, plane: loc.plane }, loc.shape, loc.rotation,
            Math.max(1, type?.sizeX ?? 1), Math.max(1, type?.sizeY ?? 1));
    }

    // ------------------------------------------------------------------ points

    private loadPoints(): void {
        this.points.clear();
        for (const full of this.configManager.getConfigurationKeys(`${GROUP}.${REGION_KEY_PREFIX}`)) {
            const key = full.slice(GROUP.length + 1);
            const regionId = Number(key.slice(REGION_KEY_PREFIX.length));
            if (!Number.isInteger(regionId)) continue;
            const points = parsePoints(this.configManager.getConfiguration(GROUP, key));
            if (points.length > 0) this.points.set(regionId, points);
        }
    }

    private savePoints(regionId: number, points: ObjectPoint[]): void {
        if (points.length === 0) {
            this.points.delete(regionId);
            this.configManager.unsetConfiguration(GROUP, REGION_KEY_PREFIX + regionId);
        } else {
            this.points.set(regionId, points);
            this.configManager.setConfiguration(GROUP, REGION_KEY_PREFIX + regionId, serializePoints(points));
        }
    }

    /** Matches every saved point against the loaded scene (RuneLite's spawn checks). */
    rebuild(): void {
        const objects: MarkedObject[] = [];
        const geom = this.osrsClient.sceneGeometry;
        if (this.isStarted() && geom && this.isLoggedIn()) {
            const scene = this.instanceScene();
            for (const [regionId, points] of this.points) {
                for (const point of points) {
                    const template = fromRegion(regionId, point.regionX, point.regionY, point.z);
                    for (const tile of toLocalInstance(scene, template)) {
                        const loc = this.findObjectAt(tile, point.id);
                        if (loc) objects.push({ loc, point });
                    }
                }
            }
        }
        this.objects = objects;
    }

    /** The loaded object with this id whose RuneLite tile is `tile`. */
    private findObjectAt(tile: WorldPoint, id: number): SceneLoc | undefined {
        const geom = this.osrsClient.sceneGeometry;
        if (!geom) return undefined;
        const type = this.locType(id);
        const sx = Math.max(1, type?.sizeX ?? 1), sy = Math.max(1, type?.sizeY ?? 1);
        const origins = new Map<string, [number, number]>();
        for (const [dx, dy] of [[0, 0], [sx >> 1, sy >> 1], [sy >> 1, sx >> 1]]) {
            origins.set(`${dx},${dy}`, [tile.x - dx, tile.y - dy]);
        }
        for (const [ox, oy] of origins.values()) {
            for (const loc of geom.locsAtTile(ox, oy, tile.plane)) {
                if (loc.id !== id) continue;
                const at = this.objectTileOf(loc);
                if (at.x === tile.x && at.y === tile.y) return loc;
            }
        }
        return undefined;
    }

    private pointFor(loc: SceneLoc): { regionId: number; point?: ObjectPoint; at: WorldPoint; name: string } {
        const at = fromLocalInstance(this.instanceScene(), this.objectTileOf(loc));
        const regionId = regionIdOf(at.x, at.y);
        const name = this.composition(loc.id)?.name ?? "";
        const point = (this.points.get(regionId) ?? []).find((p) => matchesPoint(p, loc.id, name, at));
        return { regionId, point, at, name };
    }

    isMarked(loc: SceneLoc): boolean {
        return this.objects.some((o) => sameLoc(o.loc, loc));
    }

    /** RuneLite's markObject: mark, or unmark if a point already matches. */
    markObject(loc: SceneLoc): void {
        const name = this.composition(loc.id)?.name;
        if (!name || name === "null") return;
        const { regionId, at } = this.pointFor(loc);
        const points = [...(this.points.get(regionId) ?? [])];
        const kept = points.filter((p) => !matchesPoint(p, loc.id, name, at));
        if (kept.length === points.length) {
            const fill = Number(this.config.fillColor());
            kept.push({
                id: loc.id,
                name,
                regionId,
                regionX: at.x & 63,
                regionY: at.y & 63,
                z: at.plane,
                borderColor: Number(this.config.markerColor()) >>> 0,
                fillColor: fill >= 0 ? fill >>> 0 : undefined,
            });
        }
        this.savePoints(regionId, kept);
        this.rebuild();
    }

    /** RuneLite's updateObjectConfig: change the matching point and save it. */
    updateObjectConfig(loc: SceneLoc, change: (point: ObjectPoint) => void): void {
        const { regionId, point } = this.pointFor(loc);
        if (!point) return;
        change(point);
        this.savePoints(regionId, [...(this.points.get(regionId) ?? [])]);
        this.rebuild();
    }

    /** RuneLite's getUsedColors: colours of the points in the loaded regions. */
    private usedColors(fill: boolean): number[] {
        const used: (number | undefined)[] = [];
        for (const region of sceneRegionIds(this.instanceScene())) {
            for (const p of this.points.get(region) ?? []) used.push(fill ? p.fillColor : p.borderColor);
        }
        return colorChoices(used, fill);
    }

    // ------------------------------------------------------------------ drawing rules

    /** The flags an object draws with: its own, else the global toggles. */
    flagsFor(object: MarkedObject): number {
        const own = pointFlags(object.point);
        if (own !== 0) return own;
        return (this.config.highlightHull() ? HF_HULL : 0)
            | (this.config.highlightOutline() ? HF_OUTLINE : 0)
            | (this.config.highlightClickbox() ? HF_CLICKBOX : 0)
            | (this.config.highlightTile() ? HF_TILE : 0);
    }

    /** Drawn on the player's plane, and a multiloc only while its form keeps the marked name. */
    shouldDraw(object: MarkedObject): boolean {
        if (object.loc.plane !== this.playerPlane()) return false;
        const type = this.locType(object.loc.id);
        if (type?.transforms) {
            const now = this.composition(object.loc.id);
            if (!now?.name || now.name === "null" || now.name !== object.point.name) return false;
        }
        return true;
    }

    borderColor(object: MarkedObject): number {
        return object.point.borderColor ?? (Number(this.config.markerColor()) >>> 0);
    }

    locOutlines(): LocOutline[] {
        if (!this.isStarted() || !this.isLoggedIn()) return [];
        const outlines: LocOutline[] = [];
        for (const object of this.objects) {
            if (!(this.flagsFor(object) & HF_OUTLINE) || !this.shouldDraw(object)) continue;
            const argb = this.borderColor(object);
            outlines.push({
                loc: object.loc,
                color: argb & 0xffffff,
                alpha: (argb >>> 24) / 255,
                width: Number(this.config.borderWidth()) || 2,
            });
        }
        return outlines;
    }

    // ------------------------------------------------------------------ menu

    transformMenuEntries(entries: SimpleMenuEntry[], context: MenuTransformContext): SimpleMenuEntry[] {
        if (!this.isStarted() || context.surface !== "world" || !ClientState.isShiftPressed()) return entries;
        const index = entries.findIndex((e) =>
            e.targetType === MenuTargetType.LOC && String(e.option).toLowerCase() === "examine");
        if (index < 0) return entries;
        const examine = entries[index];
        const loc = this.locFromEntry(examine);
        if (!loc) return entries;
        const out = entries.slice();
        out.splice(index, 0, ...this.markMenu(loc, String(examine.target ?? "")));
        return out;
    }

    /** The object an Examine entry names: its id near the entry's tile, on the player's plane. */
    private locFromEntry(entry: SimpleMenuEntry): SceneLoc | undefined {
        const geom = this.osrsClient.sceneGeometry;
        if (!geom || typeof entry.targetId !== "number" || typeof entry.mapX !== "number" || typeof entry.mapY !== "number") {
            return undefined;
        }
        const x = ClientState.baseX + entry.mapX;
        const y = ClientState.baseY + entry.mapY;
        const plane = this.playerPlane();
        let best: SceneLoc | undefined;
        let bestDistance = Infinity;
        for (let dx = -5; dx <= 5; dx++) {
            for (let dy = -5; dy <= 5; dy++) {
                for (const loc of geom.locsAtTile(x + dx, y + dy, plane)) {
                    if (loc.id !== entry.targetId) continue;
                    const distance = Math.max(Math.abs(dx), Math.abs(dy));
                    if (distance < bestDistance) {
                        best = loc;
                        bestDistance = distance;
                    }
                }
            }
        }
        return best;
    }

    /** "Mark object"/"Unmark object" and, when marked, the colour and style submenus. */
    private markMenu(loc: SceneLoc, target: string): SimpleMenuEntry[] {
        const marked = this.isMarked(loc) ? this.pointFor(loc).point : undefined;
        const entry = (option: string, onClick: () => void): SimpleMenuEntry =>
            ({ option, target, targetType: MenuTargetType.NONE, onClick });
        const out: SimpleMenuEntry[] = [entry(marked ? UNMARK : MARK, () => this.markObject(loc))];
        if (!marked) return out;
        const sub = (option: string, onClick: () => void): SimpleMenuEntry => ({ option, target: "", onClick });
        const setColor = (argb: number) => `<col=${(argb & 0xffffff).toString(16).padStart(6, "0")}>Set color`;

        const border = this.usedColors(false).map((c) =>
            sub(setColor(c), () => this.updateObjectConfig(loc, (p) => (p.borderColor = c))));
        border.push(sub("Pick color", () => this.pickColor(marked.borderColor ?? (Number(this.config.markerColor()) >>> 0),
            (c) => this.updateObjectConfig(loc, (p) => (p.borderColor = c)))));
        out.push({ ...entry("Mark border color", () => {}), subEntries: border });

        const fill = this.usedColors(true).map((c) =>
            sub(setColor(c), () => this.updateObjectConfig(loc, (p) => (p.fillColor = c))));
        fill.push(sub("Pick color", () => this.pickColor(marked.fillColor ?? 0x32000000,
            (c) => this.updateObjectConfig(loc, (p) => (p.fillColor = c)))));
        fill.push(sub("Reset", () => this.updateObjectConfig(loc, (p) => (p.fillColor = undefined))));
        out.push({ ...entry("Mark fill color", () => {}), subEntries: fill });

        const toggle = (key: "hull" | "outline" | "clickbox" | "tile") =>
            () => this.updateObjectConfig(loc, (p) => (p[key] = p[key] !== true));
        out.push({
            ...entry("Mark style", () => {}),
            subEntries: [
                sub("Hull", toggle("hull")),
                sub("Outline", toggle("outline")),
                sub("Clickbox", toggle("clickbox")),
                sub("Tile", toggle("tile")),
                sub("Reset", () => this.updateObjectConfig(loc, (p) => {
                    p.hull = undefined;
                    p.outline = undefined;
                    p.clickbox = undefined;
                    p.tile = undefined;
                })),
            ],
        });
        return out;
    }

    /** RuneLite's colour chooser; here the browser's picker (the colour keeps its alpha). */
    private pickColor(current: number, apply: (argb: number) => void): void {
        if (typeof document === "undefined") return;
        document.querySelectorAll("input[data-object-marker-picker]").forEach((old) => old.remove());
        const input = document.createElement("input");
        input.type = "color";
        input.dataset.objectMarkerPicker = "";
        input.value = `#${(current & 0xffffff).toString(16).padStart(6, "0")}`;
        Object.assign(input.style, { position: "fixed", left: "-100px", top: "0", opacity: "0", pointerEvents: "none" });
        input.addEventListener("change", () => {
            const rgb = parseInt(input.value.slice(1), 16);
            const alpha = current >>> 24;
            if (Number.isInteger(rgb)) apply(((alpha << 24) | rgb) >>> 0);
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

function sameLoc(a: SceneLoc, b: SceneLoc): boolean {
    return a.id === b.id && a.tileX === b.tileX && a.tileY === b.tileY && a.plane === b.plane && a.shape === b.shape;
}
