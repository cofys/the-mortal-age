/** RuneLite's GroundMarkerPoint: a marked tile, by region. Equal by position (not colour or label). */
export type GroundMarkerPoint = {
    regionId: number;
    regionX: number;
    regionY: number;
    z: number;
    /** ARGB; tiles marked before colours existed have none. */
    color?: number;
    label?: string;
};

export const REGION_PREFIX = "region_";

export function samePoint(a: GroundMarkerPoint, b: GroundMarkerPoint): boolean {
    return a.regionId === b.regionId && a.regionX === b.regionX && a.regionY === b.regionY && a.z === b.z;
}

/** RuneLite's Gson Color: "#AARRGGBB" (or "#RRGGBB"), or the legacy {value} object. */
export function readColor(value: unknown): number | undefined {
    if (typeof value === "string") {
        const hex = value.replace(/^#/, "");
        if (/^[0-9a-f]{8}$/i.test(hex)) return parseInt(hex, 16) >>> 0;
        if (/^[0-9a-f]{6}$/i.test(hex)) return (0xff000000 | parseInt(hex, 16)) >>> 0;
        return undefined;
    }
    if (value && typeof value === "object" && typeof (value as { value?: unknown }).value === "number") {
        return (value as { value: number }).value >>> 0;
    }
    return undefined;
}

/** RuneLite's Gson Color, written: "#AARRGGBB". */
export function writeColor(argb: number): string {
    return `#${(argb >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Gson's List<GroundMarkerPoint>. Throws on text that is not a list of objects, as Gson does
 * (JsonSyntaxException); missing numbers read as 0.
 */
export function parsePoints(json: string | undefined | null): GroundMarkerPoint[] {
    if (json === undefined || json === null || json === "") return [];
    const parsed: unknown = JSON.parse(json);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) throw new SyntaxError("ground markers are not a list");
    return parsed.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SyntaxError("ground marker is not an object");
        const e = entry as Record<string, unknown>;
        const point: GroundMarkerPoint = {
            regionId: Number(e.regionId) | 0,
            regionX: Number(e.regionX) | 0,
            regionY: Number(e.regionY) | 0,
            z: Number(e.z) | 0,
        };
        const color = readColor(e.color);
        if (color !== undefined) point.color = color;
        if (typeof e.label === "string") point.label = e.label;
        return point;
    });
}

/** Gson's toJson of the points: fields in declaration order, nulls left out. */
export function serializePoints(points: readonly GroundMarkerPoint[]): string {
    return JSON.stringify(points.map((p) => ({
        regionId: p.regionId,
        regionX: p.regionX,
        regionY: p.regionY,
        z: p.z,
        color: p.color === undefined ? undefined : writeColor(p.color),
        label: p.label ?? undefined,
    })));
}

/**
 * GroundMarkerSharingManager.importGroundMarkers for one region: the existing points, then each
 * imported one not already marked.
 */
export function mergeImported(existing: readonly GroundMarkerPoint[], imported: readonly GroundMarkerPoint[]): GroundMarkerPoint[] {
    const merged = [...existing];
    for (const point of imported) if (!merged.some((p) => samePoint(p, point))) merged.push(point);
    return merged;
}

/** Groups points by region, in the order regions first appear (Collectors.groupingBy). */
export function byRegion(points: readonly GroundMarkerPoint[]): Map<number, GroundMarkerPoint[]> {
    const groups = new Map<number, GroundMarkerPoint[]>();
    for (const point of points) {
        const list = groups.get(point.regionId);
        if (list) list.push(point);
        else groups.set(point.regionId, [point]);
    }
    return groups;
}
