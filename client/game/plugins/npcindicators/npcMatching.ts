/** RuneLite's Text.fromCSV: split on commas, trim, drop empties. */
export function fromCSV(text: string): string[] {
    return String(text ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** RuneLite's Text.toCSV: joined with "," and no spaces. */
export function toCSV(values: readonly string[]): string {
    return values.join(",");
}

/** RuneLite's WildcardMatcher: case-insensitive, whole name, `*` matching anything. */
export function wildcardMatches(pattern: string, text: string): boolean {
    const regex = pattern
        .split(/\*+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${regex}$`, "is").test(text);
}

export function stripTags(text: string): string {
    return String(text ?? "").replace(/<[^>]*>/g, "");
}

/** RuneLite's ColorUtil.prependColorTag. */
export function prependColorTag(text: string, rgb: number): string {
    return `<col=${(rgb & 0xffffff).toString(16).padStart(6, "0")}>${text}`;
}

/** RuneLite's MenuHighlightStyle. */
export type MenuHighlightStyle = "NONE" | "LEVEL" | "NAME" | "BOTH";

/** Recolours a highlighted NPC's menu target: the whole thing, the name or the level. */
export function recolorMenuTarget(target: string, style: MenuHighlightStyle, rgb: number): string {
    if (style === "NONE") return target;
    if (style === "BOTH") return prependColorTag(stripTags(target), rgb);
    if (!target.includes("  (level-")) return target;
    const split = target.lastIndexOf("<");
    const name = target.slice(0, split);
    const level = target.slice(split);
    return style === "NAME"
        ? prependColorTag(stripTags(name), rgb) + level
        : name + prependColorTag(stripTags(level), rgb);
}

/** RuneLite's tag styles, stored as `tagstyle_<npcId>`. */
export const TAG_STYLES = ["hull", "tile", "truetile", "swtile", "swtruetile", "outline"] as const;
export type TagStyle = (typeof TAG_STYLES)[number];

/** The submenu labels for each tag style, in RuneLite's order. */
export const TAG_STYLE_LABELS: Record<TagStyle, string> = {
    hull: "Hull",
    tile: "Tile",
    truetile: "True tile",
    swtile: "South-west tile",
    swtruetile: "South-west true tile",
    outline: "Outline",
};

export type HighlightFlags = {
    hull: boolean;
    tile: boolean;
    trueTile: boolean;
    swTile: boolean;
    swTrueTile: boolean;
    outline: boolean;
};

/** A per-NPC tag style replaces the global toggles with that one style. */
export function resolveHighlightFlags(global: HighlightFlags, tagStyle: string | undefined): HighlightFlags {
    if (!tagStyle || !(TAG_STYLES as readonly string[]).includes(tagStyle)) return global;
    return {
        hull: tagStyle === "hull",
        tile: tagStyle === "tile",
        trueTile: tagStyle === "truetile",
        swTile: tagStyle === "swtile",
        swTrueTile: tagStyle === "swtruetile",
        outline: tagStyle === "outline",
    };
}

/** The colours offered under "Tag color": those in use (up to 5), topped up with RuneLite's. */
export const DEFAULT_TAG_COLORS = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff];

export function tagColorChoices(inUse: Iterable<number>): number[] {
    const colors: number[] = [];
    for (const c of inUse) {
        const rgb = c & 0xffffff;
        if (!colors.includes(rgb)) colors.push(rgb);
        if (colors.length >= 5) return colors;
    }
    for (const c of DEFAULT_TAG_COLORS) {
        if (colors.length >= 5) break;
        if (!colors.includes(c)) colors.push(c);
    }
    return colors;
}

/** 2D convex hull (monotone chain), points in canvas pixels, counter-clockwise. */
export function convexHull(points: ReadonlyArray<readonly [number, number]>): [number, number][] {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
    const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: (readonly [number, number])[] = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: (readonly [number, number])[] = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((p) => [p[0], p[1]]);
}
