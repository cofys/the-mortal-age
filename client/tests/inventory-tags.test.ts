import { strict as assert } from "node:assert";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { ClientState } from "../game/ClientState";
import { InventoryTagsConfig, clampFillOpacity } from "../game/plugins/inventorytags/InventoryTagsConfig";
import { InventoryTagsPlugin } from "../game/plugins/inventorytags/InventoryTagsPlugin";
import { MenuSwapperPlugin } from "../game/plugins/menuswapper/MenuSwapperPlugin";
import {
    INVENTORY_TAG_OPTION,
    addInventoryTagMenu,
    canonicalItemId,
    parseTag,
    serializeTag,
    tagSpriteRgba,
} from "../game/plugins/inventorytags/inventoryTags";
import { MenuTargetType } from "../rs/MenuEntry";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";
import { applyMenuTransform, setMenuTransform, type MenuTransformContext } from "../ui/menu/menuTransforms";

const SHIFT = 81;
const RED = 0xff0000, GREEN = 0x00ff00, BLUE = 0x0000ff;
const options = (entries: SimpleMenuEntry[]) => entries.map((e) => e.option);

// --- Tag storage: RuneLite's Tag { color }, one key per item -------------------------------
assert.equal(parseTag(serializeTag(0x12ab34)), 0x12ab34);
assert.equal(parseTag(undefined), undefined);
assert.equal(parseTag("not json"), undefined, "a malformed value is no tag");
assert.equal(parseTag(JSON.stringify({ color: "red" })), undefined);
assert.equal(clampFillOpacity(400), 255);
assert.equal(clampFillOpacity(-3), 0);
assert.equal(clampFillOpacity("x"), 50);

// --- Noted items and placeholders are their real item (ItemManager.canonicalize) ----------
const objs: Record<number, any> = {
    995: { noteTemplate: -1, placeholderTemplate: -1 },
    996: { noteTemplate: 799, note: 995 },
    17000: { placeholderTemplate: 14401, placeholder: 995 },
};
assert.equal(canonicalItemId(996, (id) => objs[id]), 995);
assert.equal(canonicalItemId(17000, (id) => objs[id]), 995);
assert.equal(canonicalItemId(995, (id) => objs[id]), 995);
assert.equal(canonicalItemId(42), 42, "no definitions: unchanged");

// --- The submenu: colours in use (not the item's own), Pick, Reset when tagged; above Cancel
const base: SimpleMenuEntry[] = [
    { option: "Eat", target: "Shark" },
    { option: "Drop", target: "Shark" },
    { option: "Examine", target: "Shark" },
    { option: "Cancel", target: "" },
];
const noop = { setTag() {}, pick() {}, reset() {} };
let menu = addInventoryTagMenu(base, "Shark", { tag: undefined, colors: [RED, GREEN], ...noop });
assert.deepEqual(options(menu), ["Eat", "Drop", "Examine", INVENTORY_TAG_OPTION, "Cancel"]);
assert.deepEqual(options(menu[3].subEntries!), ["<col=ff0000>Color</col>", "<col=00ff00>Color</col>", "Pick"]);
assert.equal(menu[3].targetType, MenuTargetType.NONE);
menu = addInventoryTagMenu(base, "Shark", { tag: RED, colors: [RED, GREEN], ...noop });
assert.deepEqual(options(menu[3].subEntries!), ["<col=00ff00>Color</col>", "Pick", "Reset"], "own colour left out, Reset shown");
assert.equal(base.length, 4, "the input menu is not modified");

// --- Outline traces transparent pixels touching the sprite; fill is the sprite's shape -----
//  . . .
//  . X .
//  . . .
const sprite = new Int32Array(9);
sprite[4] = 0x123456;
const alphaAt = (rgba: Uint8ClampedArray, i: number) => rgba[i * 4 + 3];
const outline = tagSpriteRgba(sprite, 3, 3, "outline", BLUE, 255);
assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => alphaAt(outline, i)), [0, 255, 0, 255, 0, 255, 0, 255, 0]);
assert.deepEqual([...outline.slice(4, 8)], [0, 0, 255, 255], "outline in the tag colour");
const fill = tagSpriteRgba(sprite, 3, 3, "fill", RED, 50);
assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => alphaAt(fill, i)), [0, 0, 0, 0, 50, 0, 0, 0, 0]);

// --- Core: an item's right-click menu reaches plugins from any interface -------------------
let seen: MenuTransformContext[] = [];
setMenuTransform((entries, context) => {
    seen.push(context);
    return entries;
});
const widgetMenu = (itemId: number, menu: boolean): MenuTransformContext =>
    ({ surface: "widget", menu, widgetId: (387 << 16) | 17, childIndex: -1, itemId });
applyMenuTransform(base, widgetMenu(1127, true));
applyMenuTransform(base, widgetMenu(1127, false));
applyMenuTransform(base, widgetMenu(-1, true));
assert.deepEqual(seen.map((c) => c.surface === "widget" && c.itemId), [1127], "only an item's opened menu");
setMenuTransform(undefined);

const ITEMS: Record<number, number> = { 385: RED, 1127: GREEN };
const inventorySlots = [{ slot: 0, itemId: 385, quantity: 1 }, { slot: 1, itemId: 995, quantity: 100 }];
const equipmentSlots = [{ slot: 4, itemId: 1127, quantity: 1 }];
const item = (uid: number, itemId: number, x: number, extra: Record<string, unknown> = {}) =>
    ({ uid, itemId, itemQuantity: 1, itemQuantityMode: 2, _absX: x, _absY: 10, _absWidth: 36, _absHeight: 32, ...extra });
const groups: Record<number, any[]> = {
    149: [{ uid: 149 << 16, children: [item(149 << 16, 385, 0), item(149 << 16, 995, 40), item(149 << 16, 385, 80, { hidden: true })] }],
    387: [item((387 << 16) | 17, 1127, 200)],
    12: [{ uid: 12 << 16, children: [item(12 << 16, 385, 300)] }],
};
const client: any = {
    gameState: 30,
    inventory: { getSlots: () => inventorySlots },
    equipment: { getSlots: () => equipmentSlots },
    objTypeLoader: { load: (id: number) => objs[id] ?? { noteTemplate: -1, placeholderTemplate: -1 } },
    widgetManager: {
        getWidgetsForGroup: (group: number) => groups[group] ?? [],
        isEffectivelyHidden: () => false,
    },
};

async function pluginChecks(): Promise<void> {
    const config = inject(ConfigManager);
    // Menu Swapper leaves other interfaces' item menus alone.
    const swapper = new MenuSwapperPlugin();
    const worn = widgetMenu(1127, true);
    assert.equal(swapper.transformMenuEntries(base, worn), base, "menu swapper ignores worn items");

    const plugin = new InventoryTagsPlugin(client);
    await plugin.start();
    for (const [id, color] of Object.entries(ITEMS)) plugin.setTag(Number(id), color);
    assert.equal(config.getConfiguration("inventorytags", "tag_385"), JSON.stringify({ color: "#ff0000" }), "RuneLite's tag_<itemId> key");
    plugin.setTag(996, BLUE);
    assert.equal(plugin.getTag(995), BLUE, "a noted item tags its real item");
    plugin.unsetTag(995);
    assert.ok(config.getConfiguration("inventorytags", "tag_995") == null, "Reset removes the key");

    const inventoryMenu: MenuTransformContext = {
        surface: "inventory", menu: true, widgetId: 149 << 16, childIndex: 0, itemId: 385,
        target: { type: MenuTargetType.ITEM, id: 385, name: "Shark" },
    };
    ClientState.setKeybindState(SHIFT, false);
    assert.equal(plugin.transformMenuEntries(base, inventoryMenu), base, "no submenu without Shift");
    ClientState.setKeybindState(SHIFT, true);
    try {
        let out = plugin.transformMenuEntries(base, inventoryMenu);
        assert.deepEqual(options(out), ["Eat", "Drop", "Examine", INVENTORY_TAG_OPTION, "Cancel"]);
        assert.deepEqual(options(out[3].subEntries!), ["<col=00ff00>Color</col>", "Pick", "Reset"],
            "the worn item's green offered; the item's own red left out");
        out[3].subEntries![0].onClick!();
        assert.equal(plugin.getTag(385), GREEN, "a Color entry tags the item");
        out = plugin.transformMenuEntries(base, inventoryMenu);
        out[3].subEntries!.find((e) => e.option === "Reset")!.onClick!();
        assert.equal(plugin.getTag(385), undefined, "Reset removes the tag");
        plugin.setTag(385, RED);

        out = plugin.transformMenuEntries(base, worn);
        assert.ok(options(out).includes(INVENTORY_TAG_OPTION), "worn equipment is tagged too");
        const bankSide: MenuTransformContext = { surface: "widget", menu: true, widgetId: (15 << 16) | 3, childIndex: 2, itemId: 385 };
        assert.ok(options(plugin.transformMenuEntries(base, bankSide)).includes(INVENTORY_TAG_OPTION), "bank side inventory");
        const bankMain: MenuTransformContext = { surface: "widget", menu: true, widgetId: (12 << 16) | 13, childIndex: 2, itemId: 385 };
        assert.equal(plugin.transformMenuEntries(base, bankMain), base, "the bank's own grid is not tagged (as in RuneLite)");
        const leftClick: MenuTransformContext = { ...inventoryMenu, menu: false };
        assert.equal(plugin.transformMenuEntries(base, leftClick), base, "only the opened menu gets entries");
    } finally {
        ClientState.setKeybindState(SHIFT, false);
    }

    // Overlay: visible tagged items in tagged interfaces only.
    const signature = () => plugin.widgetOverlay.signature();
    const drawn = () => {
        const calls: string[] = [];
        const renderer: any = {
            getTexture: (key: string) => ({ tex: 1, key }),
            drawTexture: (tex: any) => calls.push(tex.key.split(":")[1]),
            drawRect: () => calls.push("underline"),
            createTextureFromCanvas: () => undefined,
            deleteTexture: () => true,
        };
        const rects = plugin.widgetOverlay.draw({ renderer } as any);
        return { calls, rects };
    };
    let result = drawn();
    assert.deepEqual(result.calls, ["outline", "outline"], "default: outline only, inventory shark and worn platebody");
    assert.equal(result.rects.length, 2, "hidden slots, untagged items and the bank grid are skipped");
    config.setConfigValue(InventoryTagsConfig, "showTagOutline", false);
    config.setConfigValue(InventoryTagsConfig, "tagFill", true);
    config.setConfigValue(InventoryTagsConfig, "tagUnderline", true);
    result = drawn();
    assert.deepEqual(result.calls, ["fill", "underline", "fill", "underline"]);
    config.setConfigValue(InventoryTagsConfig, "fillOpacity", 0);
    assert.deepEqual(drawn().calls, ["underline", "underline"], "fill opacity 0 draws no fill");
    // Texture sources: RuneLite's outline traces the bordered image, the fill the plain one,
    // both without quantity text; the image comes from the draw context on either renderer.
    const requested: string[] = [];
    const uncached: any = {
        renderer: { getTexture: () => undefined, drawTexture() {}, drawRect() {}, createTextureFromCanvas() {}, deleteTexture: () => true },
        itemImage: (itemId: number, quantity: number, outline: number) => {
            requested.push(`${itemId}x${quantity}:${outline}`);
            return undefined;
        },
    };
    config.setConfigValue(InventoryTagsConfig, "showTagOutline", true);
    config.setConfigValue(InventoryTagsConfig, "fillOpacity", 50);
    plugin.widgetOverlay.draw(uncached);
    assert.deepEqual(requested, ["385x1:0", "385x1:1", "1127x1:0", "1127x1:1"]);
    config.setConfigValue(InventoryTagsConfig, "showTagOutline", false);
    config.setConfigValue(InventoryTagsConfig, "fillOpacity", 0);

    const before = signature();
    assert.equal(signature(), before, "a stable scene keeps its signature");
    config.setConfigValue(InventoryTagsConfig, "tagUnderline", false);
    assert.notEqual(signature(), before, "a display change redraws");

    client.gameState = 10;
    assert.equal(signature(), "", "nothing while logged out");
    client.gameState = 30;
    await plugin.stop();
    assert.equal(signature(), "", "nothing once stopped");
    assert.equal(plugin.transformMenuEntries(base, worn), base);
}

pluginChecks()
    .then(() => console.log("inventory tags tests passed"))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
