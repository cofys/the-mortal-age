import { MenuTargetType } from "../../../rs/MenuEntry";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import {
    BANK_DEPOSITBOX,
    BANKSIDE,
    EQUIPMENT_SIDE,
    GE_OFFERS_SIDE,
    GE_PRICECHECKER_SIDE,
    GRAVESTONE_GENERIC,
    GRAVESTONE_RETRIEVAL,
    INVENTORY,
    POH_COSTUMES,
    POH_COSTUMES_SIDE,
    RAIDS_STORAGE_PRIVATE,
    RAIDS_STORAGE_SHARED,
    RAIDS_STORAGE_SIDE,
    SEED_VAULT,
    SEED_VAULT_DEPOSIT,
    SHARED_BANK_SIDE,
    SHOPSIDE,
    TRADEMAIN,
    TRADESIDE,
    WORNITEMS,
} from "@runelite/api/gameval/InterfaceID";

/** RuneLite's tag key prefix: one config key per item, `tag_<itemId>`. */
export const TAG_KEY_PREFIX = "tag_";

/**
 * Interfaces whose items are tagged: RuneLite's WidgetItemOverlay showOnInventory and
 * showOnEquipment groups. The bank's own item grid is not one of them.
 */
export const TAGGED_INTERFACES: ReadonlySet<number> = new Set([
    INVENTORY,
    WORNITEMS,
    EQUIPMENT_SIDE,
    BANKSIDE,
    SHARED_BANK_SIDE,
    BANK_DEPOSITBOX,
    SHOPSIDE,
    GE_OFFERS_SIDE,
    GE_PRICECHECKER_SIDE,
    SEED_VAULT,
    SEED_VAULT_DEPOSIT,
    TRADEMAIN,
    TRADESIDE,
    POH_COSTUMES,
    POH_COSTUMES_SIDE,
    RAIDS_STORAGE_PRIVATE,
    RAIDS_STORAGE_SHARED,
    RAIDS_STORAGE_SIDE,
    GRAVESTONE_RETRIEVAL,
    GRAVESTONE_GENERIC,
]);

export const INVENTORY_TAG_OPTION = "Inventory tag";

/** A tag as stored: RuneLite's `Tag { Color color }`, kept as JSON with an `#rrggbb` colour. */
export function serializeTag(color: number): string {
    return JSON.stringify({ color: `#${(color & 0xffffff).toString(16).padStart(6, "0")}` });
}

/** The tag's colour, or undefined for a missing or malformed value. */
export function parseTag(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    try {
        const color = (JSON.parse(value) as { color?: unknown })?.color;
        if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) return parseInt(color.slice(1), 16);
        if (typeof color === "number" && Number.isInteger(color)) return color & 0xffffff;
    } catch {}
    return undefined;
}

export function colorHex(color: number): string {
    return (color & 0xffffff).toString(16).padStart(6, "0");
}

type ObjDefinition = { noteTemplate?: number; note?: number; placeholderTemplate?: number; placeholder?: number };

/** RuneLite's ItemManager.canonicalize: a noted item or a placeholder is its real item. */
export function canonicalItemId(itemId: number, load?: (id: number) => ObjDefinition | undefined): number {
    const def = load?.(itemId);
    if (def && (def.noteTemplate ?? -1) !== -1 && (def.note ?? -1) >= 0) return def.note!;
    if (def && (def.placeholderTemplate ?? -1) !== -1 && (def.placeholder ?? -1) >= 0) return def.placeholder!;
    return itemId;
}

export type InventoryTagMenu = {
    /** The item's current tag colour, if tagged. */
    tag: number | undefined;
    /** Colours used by tagged items in the inventory and worn equipment (RuneLite's quick picks). */
    colors: readonly number[];
    setTag(color: number): void;
    pick(): void;
    reset(): void;
};

/**
 * RuneLite's Shift + right-click "Inventory tag" submenu: a "Color" entry per colour already in
 * use (other than the item's own), "Pick", and "Reset" when the item is tagged. It goes below the
 * item's options, just above Cancel.
 */
export function addInventoryTagMenu(
    entries: SimpleMenuEntry[],
    target: string,
    menu: InventoryTagMenu,
): SimpleMenuEntry[] {
    const subEntries: SimpleMenuEntry[] = [];
    for (const color of menu.colors) {
        if (menu.tag !== undefined && (menu.tag & 0xffffff) === (color & 0xffffff)) continue;
        subEntries.push({
            option: `<col=${colorHex(color)}>Color</col>`,
            target: "",
            onClick: () => menu.setTag(color),
        });
    }
    subEntries.push({ option: "Pick", target: "", onClick: () => menu.pick() });
    if (menu.tag !== undefined) subEntries.push({ option: "Reset", target: "", onClick: () => menu.reset() });
    const parent: SimpleMenuEntry = {
        option: INVENTORY_TAG_OPTION,
        target,
        targetType: MenuTargetType.NONE,
        deprioritized: true,
        onClick: () => {},
        subEntries,
    };
    const out = entries.slice();
    const cancel = out.findIndex((e) => String(e.option).toLowerCase() === "cancel");
    out.splice(cancel >= 0 ? cancel : out.length, 0, parent);
    return out;
}

/**
 * The pixels to draw for one tagged item sprite (`pixels`: 0 is transparent, else 0xRRGGBB).
 * The outline is RuneLite's SpritePixels.toBufferedOutline: every transparent pixel touching an
 * opaque one (4-neighbour); the fill is the item's own shape. RGBA, row-major.
 */
export function tagSpriteRgba(
    pixels: Int32Array,
    width: number,
    height: number,
    kind: "outline" | "fill",
    color: number,
    alpha: number,
): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
    const opaque = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < width && y < height && pixels[y * width + x] !== 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const on = kind === "fill"
                ? opaque(x, y)
                : !opaque(x, y) && (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1));
            if (!on) continue;
            const i = (y * width + x) * 4;
            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
            out[i + 3] = alpha;
        }
    }
    return out;
}
