import type { WorldPoint } from "../../scene/worldPoint";

/**
 * One marked object as RuneLite saves it (ObjectPoint): template (real-world) region and
 * region-local tile, plane, base object id and name, optional colours (0xAARRGGBB) and style
 * switches (undefined = use the global toggles).
 */
export type ObjectPoint = {
    id: number;
    name: string;
    regionId: number;
    regionX: number;
    regionY: number;
    z: number;
    borderColor?: number;
    fillColor?: number;
    hull?: boolean;
    outline?: boolean;
    clickbox?: boolean;
    tile?: boolean;
};

/** RuneLite's ColorTileObject flags. */
export const HF_HULL = 0x1;
export const HF_OUTLINE = 0x2;
export const HF_CLICKBOX = 0x4;
export const HF_TILE = 0x8;

export const REGION_KEY_PREFIX = "region_";

/** A Color as Gson may write it ({"value": int}) or as "#AARRGGBB"/"#RRGGBB" text. */
function readColor(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "object" && typeof (value as { value?: unknown }).value === "number") {
        return ((value as { value: number }).value) >>> 0;
    }
    if (typeof value === "number") return value >>> 0;
    if (typeof value === "string" && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
        const hex = value.replace(/^#/, "");
        const n = parseInt(hex, 16);
        return hex.length === 6 ? (0xff000000 | n) >>> 0 : n >>> 0;
    }
    return undefined;
}

function writeColor(argb: number | undefined): string | undefined {
    return argb === undefined ? undefined : `#${(argb >>> 0).toString(16).padStart(8, "0")}`;
}

/** RuneLite's loadPoints: the region's JSON set, without points named "null". */
export function parsePoints(json: string | null | undefined): ObjectPoint[] {
    if (!json) return [];
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: ObjectPoint[] = [];
    for (const p of raw as Record<string, unknown>[]) {
        if (!p || typeof p.name !== "string" || p.name === "null") continue;
        const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
        out.push({
            id: typeof p.id === "number" ? p.id : -1,
            name: p.name,
            regionId: Number(p.regionId) | 0,
            regionX: Number(p.regionX) | 0,
            regionY: Number(p.regionY) | 0,
            z: Number(p.z) | 0,
            // RuneLite serializes the border colour as "color".
            borderColor: readColor(p.color),
            fillColor: readColor(p.fillColor),
            hull: bool(p.hull),
            outline: bool(p.outline),
            clickbox: bool(p.clickbox),
            tile: bool(p.tile),
        });
    }
    return out;
}

/** RuneLite's savePoints JSON (field names as its ObjectPoint). */
export function serializePoints(points: readonly ObjectPoint[]): string {
    return JSON.stringify(points.map((p) => ({
        id: p.id,
        name: p.name,
        regionId: p.regionId,
        regionX: p.regionX,
        regionY: p.regionY,
        z: p.z,
        color: writeColor(p.borderColor),
        fillColor: writeColor(p.fillColor),
        hull: p.hull,
        outline: p.outline,
        clickbox: p.clickbox,
        tile: p.tile,
    })));
}

/**
 * RuneLite's findObjectPredicate: the same tile (region x/y, plane) and the same object, by
 * id or (for a multiloc) by name.
 */
export function matchesPoint(point: ObjectPoint, objectId: number, objectName: string, at: WorldPoint): boolean {
    return (point.id === -1 || point.id === objectId || point.name === objectName)
        && point.regionX === (at.x & 63)
        && point.regionY === (at.y & 63)
        && point.z === at.plane;
}

/** The point's own style switches, as ColorTileObject flags (0 = use the global toggles). */
export function pointFlags(point: ObjectPoint): number {
    return (point.hull === true ? HF_HULL : 0)
        | (point.outline === true ? HF_OUTLINE : 0)
        | (point.clickbox === true ? HF_CLICKBOX : 0)
        | (point.tile === true ? HF_TILE : 0);
}

export const DEFAULT_COLORS = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xffff00ff];

/** RuneLite's colorWithAlpha(c, c.alpha / 12): the default fill choices. */
export function withAlpha(argb: number, alpha: number): number {
    return (((alpha & 0xff) << 24) | (argb & 0xffffff)) >>> 0;
}

/**
 * The colours offered under "Mark border color" / "Mark fill color": up to five in use in the
 * loaded regions, topped up with RuneLite's defaults (at alpha / 12 for fills).
 */
export function colorChoices(inUse: Iterable<number | undefined>, fill: boolean): number[] {
    const colors: number[] = [];
    for (const c of inUse) {
        if (c === undefined || colors.includes(c >>> 0)) continue;
        colors.push(c >>> 0);
        if (colors.length >= 5) return colors;
    }
    for (const d of DEFAULT_COLORS) {
        const c = fill ? withAlpha(d, Math.floor(0xff / 12)) : d;
        if (colors.length < 5 && !colors.includes(c)) colors.push(c);
    }
    return colors;
}

/** OSRS object categories by shape: walls 0-3, decorations 4-8, game objects 9-21, ground 22. */
export function isGameObjectShape(shape: number): boolean {
    return shape >= 9 && shape <= 21;
}

/**
 * The tile RuneLite stores for an object: a game object's centre tile (its south-west corner
 * plus half its size, as its LocalPoint centre floors), otherwise its own tile.
 */
export function objectTile(origin: WorldPoint, shape: number, rotation: number, sizeX: number, sizeY: number): WorldPoint {
    if (!isGameObjectShape(shape)) return origin;
    const [sx, sy] = rotation === 1 || rotation === 3 ? [sizeY, sizeX] : [sizeX, sizeY];
    return { x: origin.x + (sx >> 1), y: origin.y + (sy >> 1), plane: origin.plane };
}
