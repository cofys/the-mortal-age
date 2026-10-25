/** Tile Packs' TilePack: a bundled pack, a custom one, or a saved visibility for a bundled one. */
export type TilePack = {
    id: number;
    packName?: string;
    link?: string;
    /** The pack's GroundMarkerPoint list, as JSON text. */
    packTiles?: string;
    /** Shown in the main list (the list filters), not whether its tiles draw. */
    visible: boolean;
};

/** Tile Packs' GroundMarkerPoint, with the colour as ARGB. */
export type TilePackPoint = {
    regionId: number;
    regionX: number;
    regionY: number;
    z: number;
    color?: number;
    label?: string;
};

/** Custom packs are numbered from here (customId starts at 9999 and is incremented first). */
export const FIRST_CUSTOM_PACK_ID = 10000;

export function isCustomPack(pack: TilePack): boolean {
    return pack.id >= FIRST_CUSTOM_PACK_ID;
}

/** The bundled tilePacks.jsonc: JSON with whole-line // comments. */
export function parseBundledPacks(text: string): Map<number, TilePack> {
    const json = text
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
    const packs = new Map<number, TilePack>();
    for (const value of Object.values(JSON.parse(json) as Record<string, unknown>)) {
        const pack = readPack(value);
        if (pack) packs.set(pack.id, pack);
    }
    return packs;
}

/** A TilePack as Gson reads it: a missing visible stays true. */
export function readPack(value: unknown): TilePack | undefined {
    if (!value || typeof value !== "object") return undefined;
    const v = value as Record<string, unknown>;
    const id = Number(v.id);
    if (!Number.isInteger(id)) return undefined;
    const pack: TilePack = { id, visible: v.visible === undefined ? true : v.visible === true };
    if (typeof v.packName === "string") pack.packName = v.packName;
    if (typeof v.link === "string") pack.link = v.link;
    if (typeof v.packTiles === "string") pack.packTiles = v.packTiles;
    return pack;
}

/** A TilePack as Gson writes it: fields in declaration order, nulls left out. */
export function writePack(pack: TilePack): string {
    return JSON.stringify({
        id: pack.id,
        packName: pack.packName,
        link: pack.link,
        packTiles: pack.packTiles,
        visible: pack.visible,
    });
}

/**
 * TilePackManager.loadPacks: a saved pack with tiles replaces the bundled one (custom packs);
 * one without tiles only sets the bundled pack's visibility.
 */
export function mergeSavedPacks(bundled: Map<number, TilePack>, saved: Iterable<TilePack>): Map<number, TilePack> {
    const packs = new Map<number, TilePack>();
    for (const [id, pack] of bundled) packs.set(id, { ...pack });
    for (const savedPack of saved) {
        const resourcePack = packs.get(savedPack.id);
        if (savedPack.packTiles !== undefined) {
            packs.set(savedPack.id, savedPack);
        } else if (resourcePack) {
            resourcePack.visible = savedPack.visible;
        }
    }
    return packs;
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

/**
 * A pack's tiles (Gson's List<GroundMarkerPoint>). Throws on text that is not a list of
 * objects, as Gson does; missing numbers read as 0.
 */
export function parseTiles(json: string | undefined): TilePackPoint[] {
    const parsed: unknown = JSON.parse(json ?? "");
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) throw new Error("tiles are not a list");
    return parsed.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("tile is not an object");
        const e = entry as Record<string, unknown>;
        const point: TilePackPoint = {
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

/** PointManager.getActivePoints: every enabled pack's tiles, by region. */
export function indexByRegion(packs: Map<number, TilePack>, enabled: Iterable<number>): Map<number, TilePackPoint[]> {
    const byRegion = new Map<number, TilePackPoint[]>();
    const enabledIds = new Set(enabled);
    for (const [id, pack] of packs) {
        if (!enabledIds.has(id)) continue;
        let tiles: TilePackPoint[];
        try {
            tiles = parseTiles(pack.packTiles);
        } catch {
            continue;
        }
        for (const tile of tiles) {
            const list = byRegion.get(tile.regionId);
            if (list) list.push(tile);
            else byRegion.set(tile.regionId, [tile]);
        }
    }
    return byRegion;
}

/** The custom pack form's checks, with the plugin's messages; undefined when the pack can be added. */
export function customPackError(name: string, tiles: string): string | undefined {
    if (name.length === 0) return "Must add a pack name";
    if (tiles.length === 0) return "Must add tiles";
    try {
        if (parseTiles(tiles).length === 0) return "Error parsing tiles, check the formatting";
    } catch {
        return "Error parsing tiles, check the formatting";
    }
    return undefined;
}
