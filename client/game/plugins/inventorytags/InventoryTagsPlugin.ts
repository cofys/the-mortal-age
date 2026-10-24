import { GameState } from "@runelite/api/GameState";
import { ConfigChanged } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import type { MenuTransformContext } from "../../../ui/menu/menuTransforms";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";
import { InventoryTagsConfig, clampFillOpacity, type InventoryTagsDisplay } from "./InventoryTagsConfig";
import {
    TAG_KEY_PREFIX,
    TAGGED_INTERFACES,
    addInventoryTagMenu,
    canonicalItemId,
    colorHex,
    parseTag,
    serializeTag,
    tagSpriteRgba,
} from "./inventoryTags";

type TaggedItem = {
    itemId: number;
    quantity: number;
    color: number;
    x: number;
    y: number;
    w: number;
    h: number;
};

type Rect = { x: number; y: number; w: number; h: number };

/** Sprite textures kept per item, quantity, colour and kind; cleared past this many. */
const MAX_TAG_TEXTURES = 256;
const TEXTURE_KEY_PREFIX = "inventorytags:";

/**
 * RuneLite 1.13.3 Inventory Tags. Shift + right-click an item in the inventory, worn equipment
 * or another inventory-like interface for "Inventory tag": a colour already in use, Pick or
 * Reset. Tagged items are outlined, filled and/or underlined in their tag colour.
 */
export class InventoryTagsPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Inventory Tags",
        description: "Add the ability to tag items in your inventory",
        tags: ["highlight", "items", "overlay", "tagging"],
        enabledByDefault: false,
        configKey: "inventorytagsplugin",
    };

    static config = InventoryTagsConfig;

    private readonly configManager = inject(ConfigManager);
    private readonly config = this.configManager.getConfig(InventoryTagsConfig);
    private readonly osrsClient: OsrsClient;
    /** Tag colour per canonical item id, read from the `tag_<id>` keys. */
    private tags = new Map<number, number>();
    private readonly textureKeys = new Set<string>();
    private textureRenderer?: WidgetOverlayDrawContext["renderer"];

    readonly widgetOverlay: WidgetOverlay = {
        signature: () => {
            const items = this.taggedItems();
            if (items.length === 0) return "";
            const d = this.display();
            return JSON.stringify([d, items]);
        },
        draw: (context) => this.draw(context),
    };

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
    }

    protected async startUp(): Promise<void> {
        this.loadTags();
    }

    protected async shutDown(): Promise<void> {
        this.releaseTextures();
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() !== InventoryTagsConfig.group) return;
        const key = String(event.getKey() ?? "");
        if (!key || key.startsWith(TAG_KEY_PREFIX)) this.loadTags();
        if (key === "fillOpacity") this.releaseTextures();
    }

    // ------------------------------------------------------------------ tags

    getTag(itemId: number): number | undefined {
        return this.tags.get(this.canonical(itemId));
    }

    setTag(itemId: number, color: number): void {
        this.configManager.setConfiguration(InventoryTagsConfig.group, TAG_KEY_PREFIX + this.canonical(itemId), serializeTag(color));
        this.loadTags();
    }

    unsetTag(itemId: number): void {
        this.configManager.unsetConfiguration(InventoryTagsConfig.group, TAG_KEY_PREFIX + this.canonical(itemId));
        this.loadTags();
    }

    private loadTags(): void {
        const tags = new Map<number, number>();
        const prefix = `${InventoryTagsConfig.group}.${TAG_KEY_PREFIX}`;
        for (const full of this.configManager.getConfigurationKeys(prefix)) {
            const key = full.slice(InventoryTagsConfig.group.length + 1);
            const itemId = Number(key.slice(TAG_KEY_PREFIX.length));
            if (!Number.isInteger(itemId) || itemId < 0) continue;
            const color = parseTag(this.configManager.getConfiguration(InventoryTagsConfig.group, key));
            if (color !== undefined) tags.set(itemId, color);
        }
        this.tags = tags;
    }

    private canonical(itemId: number): number {
        const loader: any = (this.osrsClient as any)?.objTypeLoader;
        return canonicalItemId(itemId, loader ? (id) => loader.load(id) : undefined);
    }

    /** Colours of the tagged items carried or worn: RuneLite's quick picks. */
    private colorsInUse(): number[] {
        const colors = new Set<number>();
        for (const inventory of [this.osrsClient.inventory, this.osrsClient.equipment]) {
            for (const slot of inventory?.getSlots?.() ?? []) {
                if (!(slot.itemId >= 0)) continue;
                const tag = this.getTag(slot.itemId);
                if (tag !== undefined) colors.add(tag);
            }
        }
        return [...colors];
    }

    // ------------------------------------------------------------------ menu

    transformMenuEntries(entries: SimpleMenuEntry[], context: MenuTransformContext): SimpleMenuEntry[] {
        if (!this.isStarted() || !context.menu || !ClientState.isShiftPressed()) return entries;
        const itemId = context.surface === "world" ? -1 : context.itemId ?? -1;
        const widgetId = context.surface === "world" ? 0 : context.widgetId ?? 0;
        if (!(itemId >= 0) || !TAGGED_INTERFACES.has(widgetId >>> 16)) return entries;
        if (entries.some((e) => e.option === "Inventory tag")) return entries;
        const examine = entries.find((e) => String(e.option).toLowerCase() === "examine");
        const target = examine?.target ?? (context.surface === "inventory" ? context.target.name : "");
        return addInventoryTagMenu(entries, target, {
            tag: this.getTag(itemId),
            colors: this.colorsInUse(),
            setTag: (color) => this.setTag(itemId, color),
            pick: () => this.pickColor(itemId),
            reset: () => this.unsetTag(itemId),
        });
    }

    /** RuneLite opens a colour chooser; here it is the browser's own colour picker. */
    private pickColor(itemId: number): void {
        if (typeof document === "undefined") return;
        // A picker closed without a choice fires nothing; drop it before opening another.
        document.querySelectorAll("input[data-inventory-tag-picker]").forEach((old) => old.remove());
        const input = document.createElement("input");
        input.dataset.inventoryTagPicker = "";
        input.type = "color";
        input.value = `#${colorHex(this.getTag(itemId) ?? 0xffffff)}`;
        Object.assign(input.style, { position: "fixed", left: "-100px", top: "0", opacity: "0", pointerEvents: "none" });
        const done = () => input.remove();
        input.addEventListener("change", () => {
            const color = parseInt(input.value.slice(1), 16);
            if (Number.isInteger(color)) this.setTag(itemId, color);
            done();
        }, { once: true });
        input.addEventListener("blur", () => setTimeout(done, 0), { once: true });
        document.body.appendChild(input);
        try {
            input.showPicker();
        } catch {
            input.click();
        }
    }

    // ------------------------------------------------------------------ overlay

    private display(): InventoryTagsDisplay {
        return {
            outline: this.config.showTagOutline() !== false,
            underline: this.config.tagUnderline() === true,
            fill: this.config.tagFill() === true,
            fillOpacity: clampFillOpacity(this.config.fillOpacity()),
        };
    }

    /** Every visible tagged item in the tagged interfaces, in device pixels. */
    private taggedItems(): TaggedItem[] {
        const client: any = this.osrsClient;
        const manager = client?.widgetManager;
        if (!this.isStarted() || this.tags.size === 0 || !manager) return [];
        if (client.gameState !== GameState.LOGGED_IN) return [];
        const items: TaggedItem[] = [];
        const seen = new Set<any>();
        const visit = (widget: any, parentHidden: boolean): void => {
            if (!widget || seen.has(widget)) return;
            seen.add(widget);
            const hidden = parentHidden || widget.hidden === true || widget.isHidden === true;
            if (hidden) return;
            const itemId = typeof widget.itemId === "number" ? widget.itemId : -1;
            if (itemId >= 0) {
                const color = this.getTag(itemId);
                const { _absX: x, _absY: y, _absWidth: w, _absHeight: h } = widget;
                if (color !== undefined && [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
                    items.push({
                        itemId,
                        quantity: (widget.itemQuantity ?? 1) | 0,
                        color, x, y, w, h,
                    });
                }
            }
            for (const child of widget.children ?? []) visit(child, hidden);
        };
        for (const group of TAGGED_INTERFACES) {
            for (const widget of manager.getWidgetsForGroup?.(group) ?? []) {
                if (typeof widget?.uid === "number" && manager.isEffectivelyHidden?.(widget.uid)) continue;
                visit(widget, false);
            }
        }
        return items;
    }

    private draw(context: WidgetOverlayDrawContext): Rect[] {
        const items = this.taggedItems();
        if (items.length === 0) return [];
        const { renderer } = context;
        if (this.textureRenderer !== renderer) {
            this.textureKeys.clear();
            this.textureRenderer = renderer;
        }
        const d = this.display();
        const rects: Rect[] = [];
        for (const item of items) {
            const [r, g, b] = [(item.color >> 16) & 0xff, (item.color >> 8) & 0xff, item.color & 0xff];
            if (d.fill && d.fillOpacity > 0) {
                const tex = this.texture(context, item, "fill", d.fillOpacity);
                if (tex) renderer.drawTexture(tex, item.x, item.y, item.w, item.h);
            }
            if (d.outline) {
                const tex = this.texture(context, item, "outline", 255);
                if (tex) renderer.drawTexture(tex, item.x, item.y, item.w, item.h);
            }
            if (d.underline) {
                // RuneLite draws a one-pixel line two pixels below the item.
                const scale = item.h / 32;
                const thickness = Math.max(1, Math.round(scale));
                renderer.drawRect(item.x, item.y + item.h + 2 * scale, item.w, thickness, [r / 255, g / 255, b / 255, 1]);
            }
            rects.push({ x: item.x, y: item.y, w: item.w, h: item.h + Math.ceil(3 * (item.h / 32)) });
        }
        return rects;
    }

    /**
     * The outline or fill of one item image as a texture, built once per item/colour. As in
     * RuneLite, the outline traces the image with its black border (getItemOutline) and the
     * fill covers the plain image (getImage + fillImage); neither has the quantity text.
     */
    private texture(context: WidgetOverlayDrawContext, item: TaggedItem, kind: "outline" | "fill", alpha: number) {
        const { renderer } = context;
        const key = `${TEXTURE_KEY_PREFIX}${kind}:${item.itemId}:${item.quantity}:${colorHex(item.color)}:${alpha}`;
        const cached = renderer.getTexture(key);
        if (cached) return cached;
        const source = context.itemImage?.(item.itemId, item.quantity, kind === "outline" ? 1 : 0);
        const pixels = source && opaquePixels(source);
        if (!source || !pixels || typeof document === "undefined") return undefined;
        const { width, height } = source;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        const image = ctx.createImageData(width, height);
        image.data.set(tagSpriteRgba(pixels, width, height, kind, item.color, alpha));
        ctx.putImageData(image, 0, 0);
        if (this.textureKeys.size >= MAX_TAG_TEXTURES) this.releaseTextures();
        this.textureKeys.add(key);
        return renderer.createTextureFromCanvas(key, canvas);
    }

    private releaseTextures(): void {
        const renderer = this.textureRenderer;
        for (const key of this.textureKeys) renderer?.deleteTexture(key);
        this.textureKeys.clear();
    }
}

/** The image's pixels as 0 (transparent) or 1 (drawn), the form tagSpriteRgba reads. */
function opaquePixels(source: HTMLCanvasElement): Int32Array | undefined {
    const { width, height } = source;
    const data = source.getContext("2d")?.getImageData(0, 0, width, height).data;
    if (!data) return undefined;
    const out = new Int32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] !== 0 ? 1 : 0;
    return out;
}
