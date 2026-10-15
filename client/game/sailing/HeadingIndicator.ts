import { HSL_RGB_MAP } from "../../rs/util/ColorUtil";
import type { ModelData } from "../../rs/model/ModelData";
import {
    INTERACTION_WORLD_ROOT,
    TileInteractionMode,
    interactionModes,
} from "../InteractionModes";
import type { WorldEntity } from "../worldview/WorldEntity";
import { headingIndexToward } from "./HelmSteering";

const FINE_UNITS_PER_TILE = 128;
const RS_ANGLE_TO_RADIANS = Math.PI / 1024;
/** Helm headings are 16 steps of 128 angle units. */
const HEADING_STEP = 128;
/**
 * How long the yellow arrow stays where a heading was set. Live shows it for "a few ticks"
 * after the click; two ticks until a capture or video says otherwise.
 */
export const HEADING_FLASH_MS = 1200;
/** Lifts the arrows off the water so the sea surface doesn't hide them. */
const SURFACE_LIFT_TILES = 0.02;

/** Triangles of one colour, in world tile units: x, height (negative is up), y per vertex. */
export interface OverlayTriangleBatch {
    rgba: [number, number, number, number];
    positions: number[];
}

interface ArrowPart {
    rgba: [number, number, number, number];
    /** Model-space x, y, z per vertex, three vertices per triangle. */
    vertices: number[];
}

/**
 * Flattens a heading indicator model into one list of triangles per face colour. OSRS face
 * alpha is transparency: 0 is opaque.
 */
export function arrowParts(model: ModelData): ArrowPart[] {
    const byColour = new Map<string, ArrowPart>();
    for (let face = 0; face < model.faceCount; face++) {
        const rgb = HSL_RGB_MAP[model.faceColors[face] & 0xffff] ?? 0;
        const opacity = 1 - ((model.faceAlphas?.[face] ?? 0) & 0xff) / 255;
        const key = `${rgb}:${opacity}`;
        let part = byColour.get(key);
        if (!part) {
            part = {
                rgba: [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255, opacity],
                vertices: [],
            };
            byColour.set(key, part);
        }
        for (const v of [model.indices1[face], model.indices2[face], model.indices3[face]]) {
            part.vertices.push(model.verticesX[v], model.verticesY[v], model.verticesZ[v]);
        }
    }
    return [...byColour.values()];
}

/**
 * Places an arrow model around the boat, pointing outward along `angle` (0 south, 512 west,
 * 1024 north, 1536 east). The model's tip is at its lowest z, so model z runs back toward the
 * boat and model x runs sideways.
 */
export function placeArrow(
    out: OverlayTriangleBatch[],
    parts: ArrowPart[],
    centreX: number,
    centreY: number,
    radius: number,
    angle: number,
    surfaceHeight: number,
): void {
    const theta = (angle & 2047) * RS_ANGLE_TO_RADIANS;
    const dirX = -Math.sin(theta);
    const dirY = -Math.cos(theta);
    for (const part of parts) {
        const positions: number[] = [];
        for (let i = 0; i < part.vertices.length; i += 3) {
            const side = part.vertices[i];
            const height = part.vertices[i + 1];
            const along = radius - part.vertices[i + 2];
            const x = centreX + dirX * along + dirY * side;
            const y = centreY + dirY * along - dirX * side;
            positions.push(
                x / FINE_UNITS_PER_TILE,
                surfaceHeight + height / FINE_UNITS_PER_TILE - SURFACE_LIFT_TILES,
                y / FINE_UNITS_PER_TILE,
            );
        }
        out.push({ rgba: part.rgba, positions });
    }
}

/** Whether a world point lies on a boat's own footprint (its world entity's zones). */
export function isOverBoat(boat: WorldEntity, sizeX: number, sizeZ: number, x: number, y: number): boolean {
    const theta = (boat.position.orientation & 2047) * RS_ANGLE_TO_RADIANS;
    const dx = x - boat.position.x;
    const dy = y - boat.position.z;
    const localX = dx * Math.cos(theta) - dy * Math.sin(theta);
    const localY = dy * Math.cos(theta) + dx * Math.sin(theta);
    return Math.abs(localX) <= sizeX * 64 && Math.abs(localY) <= sizeZ * 64;
}

export interface HeadingIndicatorFrame {
    now: number;
    /** The boat the local player stands on, with its world entity index and footprint in tiles. */
    boat: WorldEntity;
    boatIndex: number;
    sizeX: number;
    sizeZ: number;
    /** Water height at the boat, in tile units (as the overlays sample it). */
    surfaceHeight: number;
    /** Where the mouse meets the sea, in world fine units, when it is over the game view. */
    mouseSeaPoint?: { x: number; y: number };
    /** Model loader for the two arrow models. */
    getModel(id: number): ModelData | undefined;
}

/**
 * The helm's heading indicator, drawn by the client as live does: while clicks steer (the
 * heading interaction mode), a white arrow around the boat points at the heading a click under
 * the mouse would set, and a click leaves a yellow arrow at the heading it set for a moment.
 * The two show independently. The models are the cache's graphics defaults pair.
 */
export class HeadingIndicator {
    private models: [number, number] = [-1, -1];
    private readonly parts = new Map<number, ArrowPart[]>();
    private flash?: { heading: number; at: number };
    /** How loading the models from the graphics defaults went, for `__headingDebug`. */
    loadStatus = "not started";

    setModels(models: [number, number]): void {
        this.models = models;
        this.parts.clear();
    }

    /** A click set a heading (0-15); the yellow arrow shows it. */
    onHeadingSet(heading: number, now: number): void {
        this.flash = { heading: heading & 15, at: now };
    }

    /** This frame's arrows, or undefined when there are none. */
    build(frame: HeadingIndicatorFrame): OverlayTriangleBatch[] | undefined {
        const { boat } = frame;
        const out: OverlayTriangleBatch[] = [];
        const radius = (Math.max(frame.sizeX, frame.sizeZ) * FINE_UNITS_PER_TILE) / 2;
        const [whiteId, yellowId] = this.models;

        const mouse = frame.mouseSeaPoint;
        if (mouse) {
            const overBoat = isOverBoat(boat, frame.sizeX, frame.sizeZ, mouse.x, mouse.y);
            const world = overBoat ? frame.boatIndex : INTERACTION_WORLD_ROOT;
            const heading = headingIndexToward(boat.position.x, boat.position.z, mouse.x, mouse.y);
            const white = this.partsFor(whiteId, frame);
            if (white && heading !== undefined && interactionModes.tileMode(world) === TileInteractionMode.Heading) {
                placeArrow(out, white, boat.position.x, boat.position.z, radius, heading * HEADING_STEP, frame.surfaceHeight);
            }
        }

        if (this.flash && frame.now - this.flash.at > HEADING_FLASH_MS) this.flash = undefined;
        const yellow = this.flash && this.partsFor(yellowId, frame);
        if (this.flash && yellow) {
            placeArrow(
                out, yellow, boat.position.x, boat.position.z, radius,
                this.flash.heading * HEADING_STEP, frame.surfaceHeight,
            );
        }
        return out.length > 0 ? out : undefined;
    }

    debugState(getModel: (id: number) => ModelData | undefined): object {
        return {
            models: this.models,
            loadStatus: this.loadStatus,
            loaded: this.models.map((id) => id >= 0 && !!getModel(id)),
            flash: this.flash ?? null,
        };
    }

    private partsFor(modelId: number, frame: HeadingIndicatorFrame): ArrowPart[] | undefined {
        if (modelId < 0) return undefined;
        let parts = this.parts.get(modelId);
        if (!parts) {
            const model = frame.getModel(modelId);
            if (!model) return undefined;
            parts = arrowParts(model);
            this.parts.set(modelId, parts);
        }
        return parts;
    }
}

export const headingIndicator = new HeadingIndicator();

/** The pieces of the client and renderer the indicator reads each frame. */
export interface HeadingIndicatorHost {
    osrsClient: {
        controlledPlayerServerId: number;
        menuOpen?: boolean;
        modelLoader?: { getModel(id: number): ModelData | undefined };
        inputManager?: { mouseX: number; mouseY: number };
        camera?: { containsScreenPoint(x: number, y: number): boolean };
        playerEcs: {
            getIndexForServerId(serverId: number): number | undefined;
            getWorldViewId(index: number): number;
        };
        worldViewManager: {
            getWorldEntity(entityIndex: number): WorldEntity | undefined;
            getWorldView(entityIndex: number): { sizeXEntity: number; sizeZEntity: number } | undefined;
        };
    };
    sampleHeightAtExactPlane(x: number, y: number, plane: number): number;
    pickSeaPointAt?(entityIndex: number, mouseX: number, mouseY: number): { x: number; y: number } | undefined;
}

let lastDebugAt = 0;

interface DeckDebugHost {
    mapManager?: {
        mapSquares: Map<number, { id: number; canRender(frame: number): boolean; frameLoaded?: number }>;
        loadingMapIds: Set<number>;
        worldEntityMapIds: Set<number>;
        visibleMaps: { id: number }[];
    };
    worldEntityOverlays?: Map<number, unknown>;
    worldEntityAnimator?: { getTransform(entityIndex: number): unknown; getMovement(entityIndex: number): unknown };
    stats?: { frameCount: number };
}

/** Where the boat's deck scene is in the renderer's pipeline (for `__headingDebug`). */
function deckState(host: DeckDebugHost, entityIndex: number): object {
    const manager = host.mapManager;
    if (!manager) return { mapManager: false };
    const mapX = 200 + entityIndex;
    const mapId = (mapX << 8) | mapX;
    const square = manager.mapSquares.get(mapId);
    return {
        overlayRecord: host.worldEntityOverlays?.has(entityIndex) ?? null,
        square: !!square,
        canRender: square && host.stats ? square.canRender(host.stats.frameCount) : null,
        loading: manager.loadingMapIds.has(mapId),
        drawList: manager.worldEntityMapIds.has(mapId),
        visible: manager.visibleMaps.some((map) => map.id === mapId),
        movement: !!host.worldEntityAnimator?.getMovement(entityIndex),
        transform: !!host.worldEntityAnimator?.getTransform(entityIndex),
    };
}

/** `__headingDebug = true` in the console logs, once a second, what the indicator saw. */
function debug(now: number, details: () => object): void {
    if ((globalThis as { __headingDebug?: boolean }).__headingDebug !== true) return;
    if (now - lastDebugAt < 1000) return;
    lastDebugAt = now;
    console.log("[heading]", JSON.stringify(details()));
}

/** This frame's heading indicator triangles for a renderer, or undefined off a boat. */
export function headingIndicatorTriangles(host: HeadingIndicatorHost, now: number): OverlayTriangleBatch[] | undefined {
    const client = host.osrsClient;
    const index = client.playerEcs.getIndexForServerId(client.controlledPlayerServerId);
    const boatIndex = index === undefined ? -1 : client.playerEcs.getWorldViewId(index) | 0;
    if (boatIndex < 0) {
        debug(now, () => ({ step: "not on a boat", index, boatIndex }));
        return undefined;
    }
    const boat = client.worldViewManager.getWorldEntity(boatIndex);
    const view = client.worldViewManager.getWorldView(boatIndex);
    const modelLoader = client.modelLoader;
    if (!boat?.hasPosition || !view || !modelLoader) {
        debug(now, () => ({ step: "no boat data", boatIndex, boat: !!boat, placed: boat?.hasPosition, view: !!view, modelLoader: !!modelLoader }));
        return undefined;
    }

    const input = client.inputManager;
    const mouseInView =
        !!input && input.mouseX >= 0 && input.mouseY >= 0 && !client.menuOpen &&
        (client.camera?.containsScreenPoint(input.mouseX, input.mouseY) ?? true);
    const triangles = headingIndicator.build({
        now,
        boat,
        boatIndex,
        sizeX: view.sizeXEntity,
        sizeZ: view.sizeZEntity,
        surfaceHeight: host.sampleHeightAtExactPlane(
            boat.position.x / FINE_UNITS_PER_TILE,
            boat.position.z / FINE_UNITS_PER_TILE,
            0,
        ),
        mouseSeaPoint: mouseInView ? host.pickSeaPointAt?.(boatIndex, input!.mouseX, input!.mouseY) : undefined,
        getModel: (id) => modelLoader.getModel(id),
    });
    debug(now, () => ({
        step: "built",
        boatIndex,
        boat: { x: boat.position.x, z: boat.position.z, orientation: boat.position.orientation },
        size: [view.sizeXEntity, view.sizeZEntity],
        mouse: input ? [input.mouseX, input.mouseY] : null,
        mouseInView,
        mouseSeaPoint: mouseInView ? host.pickSeaPointAt?.(boatIndex, input!.mouseX, input!.mouseY) ?? null : null,
        modes: { root: interactionModes.tileMode(INTERACTION_WORLD_ROOT), boat: interactionModes.tileMode(boatIndex) },
        ...headingIndicator.debugState((id) => modelLoader.getModel(id)),
        batches: triangles?.length ?? 0,
        firstVertex: triangles?.[0]?.positions.slice(0, 3) ?? null,
        surface: host.sampleHeightAtExactPlane(boat.position.x / FINE_UNITS_PER_TILE, boat.position.z / FINE_UNITS_PER_TILE, 0),
        deck: deckState(host as unknown as DeckDebugHost, boatIndex),
    }));
    return triangles;
}
