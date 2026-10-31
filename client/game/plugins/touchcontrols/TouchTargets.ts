import type { ContinuousMovementRefusal } from "../../movement/ContinuousMovement";
import type { ClientGroundItemStack } from "../../data/ground/GroundItemStore";
import type { SceneLoc } from "../../scene/SceneGeometry";

/** One of a loc's or NPC's five cache options. */
export type CacheOption = { option: string; actionIndex: number };

/** A ground item's option: which stack, under the name the world menu gives it. */
export type ObjOption = {
    option: string;
    actionIndex: number;
    stack: ClientGroundItemStack;
    name: string;
    /** Ground Items' hidden items: their Take goes below everything else. */
    deprioritized: boolean;
};

/** What the action button is for, with the options its current form offers. */
export type TouchTarget = { name: string } & (
    | { kind: "loc"; loc: SceneLoc; options: ReadonlyArray<CacheOption> }
    | { kind: "npc"; ecsId: number; serverId: number; typeId: number; options: ReadonlyArray<CacheOption> }
    | { kind: "obj"; options: ReadonlyArray<ObjOption> }
);

/** A loc the player walked into. */
export type LocTouchTarget = Extract<TouchTarget, { kind: "loc" }>;

/** The scene and cache lookups target finding needs; the plugin builds it from the client. */
export type TouchTargetWorld = {
    locsAtTile(x: number, y: number, plane: number): SceneLoc[];
    /** The loc's footprint in tiles, unrotated (LocType sizeX/sizeY). */
    size(id: number): { sizeX: number; sizeY: number };
    /** The loc's current form (a multiloc's transform): its name and cache actions. */
    current(id: number): { name: string; actions: ReadonlyArray<string | null | undefined> } | undefined;
    /** Server op flags for this loc, which hide options; undefined shows them all. */
    opFlags(x: number, y: number, id: number): number | undefined;
};

// Loc shapes (LocModelType): straight wall, wall corner, diagonal wall, centrepieces, ground decor.
const WALL = 0, WALL_CORNER = 2, WALL_DIAGONAL = 9, CENTREPIECE = 10, CENTREPIECE_DIAGONAL = 11, GROUND_DECOR = 22;
/** Largest loc footprint searched for, in tiles. */
const MAX_SIZE = 5;

/** The tiles a loc covers: its origin plus its size, swapped on a quarter turn. */
function footprint(loc: SceneLoc, world: TouchTargetWorld): { x0: number; y0: number; x1: number; y1: number } {
    const { sizeX, sizeY } = world.size(loc.id);
    const [w, h] = loc.rotation & 1 ? [sizeY, sizeX] : [sizeX, sizeY];
    return { x0: loc.tileX, y0: loc.tileY, x1: loc.tileX + Math.max(1, w) - 1, y1: loc.tileY + Math.max(1, h) - 1 };
}

/** The loc with its usable options, or undefined when it has none. */
export function targetFor(loc: SceneLoc, world: TouchTargetWorld): LocTouchTarget | undefined {
    const type = world.current(loc.id);
    if (!type || !type.name || type.name === "null") return undefined;
    const flags = world.opFlags(loc.tileX, loc.tileY, loc.id);
    const options: { option: string; actionIndex: number }[] = [];
    type.actions.forEach((option, actionIndex) => {
        if (option && actionIndex < 5 && (flags === undefined || flags & (1 << actionIndex))) options.push({ option, actionIndex });
    });
    return options.length ? { kind: "loc", loc, name: type.name, options } : undefined;
}

/** Wall sides a straight wall or corner covers on its tile: 0 west, 1 north, 2 east, 3 south. */
function wallSides(loc: SceneLoc): number[] {
    if (loc.shape === WALL) return [loc.rotation & 3];
    if (loc.shape === WALL_CORNER) return [loc.rotation & 3, (loc.rotation + 1) & 3];
    return [];
}

/**
 * What stopped the walk: a wall or door on the refused edge, else a loc covering the tile the
 * player tried to enter (a tree, bank booth or rock). Only locs with options count.
 */
export function findBlockingTarget(refusal: ContinuousMovementRefusal, world: TouchTargetWorld): LocTouchTarget | undefined {
    const { fromX, fromY, toX, toY, level } = refusal;
    for (const [x, y, ox, oy] of [[fromX, fromY, toX, toY], [toX, toY, fromX, fromY]]) {
        const sides = [ox < x ? 0 : ox > x ? 2 : -1, oy > y ? 1 : oy < y ? 3 : -1];
        for (const loc of world.locsAtTile(x, y, level)) {
            const facing = loc.shape === WALL_DIAGONAL || wallSides(loc).some((side) => sides.includes(side));
            const target = facing ? targetFor(loc, world) : undefined;
            if (target) return target;
        }
    }
    for (let x = toX; x > toX - MAX_SIZE; x--) {
        for (let y = toY; y > toY - MAX_SIZE; y--) {
            for (const loc of world.locsAtTile(x, y, level)) {
                if (loc.shape !== CENTREPIECE && loc.shape !== CENTREPIECE_DIAGONAL && loc.shape !== GROUND_DECOR) continue;
                const f = footprint(loc, world);
                if (toX < f.x0 || toX > f.x1 || toY < f.y0 || toY > f.y1) continue;
                const target = targetFor(loc, world);
                if (target) return target;
            }
        }
    }
    return undefined;
}

/** Whether the loc is still in the scene and the player stands on or next to it. */
export function isStillInReach(loc: SceneLoc, world: TouchTargetWorld, x: number, y: number, plane: number): boolean {
    if (plane !== loc.plane) return false;
    const present = world.locsAtTile(loc.tileX, loc.tileY, loc.plane)
        .some((l) => l.id === loc.id && l.shape === loc.shape && l.rotation === loc.rotation);
    if (!present) return false;
    const f = footprint(loc, world);
    const dx = Math.max(f.x0 - x, 0, x - f.x1), dy = Math.max(f.y0 - y, 0, y - f.y1);
    return Math.max(dx, dy) <= 1;
}
