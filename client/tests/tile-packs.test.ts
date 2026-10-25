import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { packTemplateChunk } from "../common/instance/InstanceTypes";
import { ClientState } from "../game/ClientState";
import {
    customPackError,
    indexByRegion,
    mergeSavedPacks,
    parseBundledPacks,
    parseTiles,
    readColor,
    writePack,
    type TilePack,
} from "../game/plugins/tilepacks/tilePackData";
import { TilePackStore, PACK_GROUP } from "../game/plugins/tilepacks/TilePackStore";
import { TilePacksConfig } from "../game/plugins/tilepacks/TilePacksConfig";
import { TilePacksPanel } from "../game/plugins/tilepacks/TilePacksPanel";
import { TilePacksPlugin } from "../game/plugins/tilepacks/TilePacksPlugin";
import { chatHistory } from "../rs/cs2/ChatHistory";

const config = inject(ConfigManager);
const clearConfig = () => {
    for (const group of [PACK_GROUP, TilePacksConfig.group]) {
        for (const key of config.getConfigurationKeys(`${group}.`)) config.unsetConfiguration(group, key.slice(group.length + 1));
    }
};

// --- The bundled data: the Hub's file, parsed as the plugin does ------------------------------
const bundledText = readFileSync(new URL("../public/tilepacks/tilePacks.jsonc", import.meta.url), "utf8");
const bundled = parseBundledPacks(bundledText);
assert.equal(bundled.size, 84, "84 packs in the Hub's tilePacks.jsonc");
for (const pack of bundled.values()) {
    assert.ok(pack.packName && pack.visible, `pack ${pack.id} has a name and starts visible`);
    assert.ok(parseTiles(pack.packTiles).length > 0, `pack ${pack.id} tiles parse`);
}
assert.equal(bundled.get(1)?.packName, "Abyssal Sire");
assert.ok(bundled.get(1)?.link?.includes("youtube.com"));

// --- Colours: RuneLite's Gson Color forms -----------------------------------------------------
assert.equal(readColor("#FFFFFF00"), 0xffffff00);
assert.equal(readColor("#00ff00"), 0xff00ff00, "no alpha: opaque");
assert.equal(readColor({ value: -1, falpha: 0 }), 0xffffffff, "the legacy {value} object");
assert.equal(readColor(undefined), undefined);
const tiles = parseTiles('[{"regionId":12850,"regionX":5,"regionY":6,"z":0,"color":"#FFFF0000","label":"A"},{"regionId":12850}]');
assert.deepEqual(tiles, [
    { regionId: 12850, regionX: 5, regionY: 6, z: 0, color: 0xffff0000, label: "A" },
    { regionId: 12850, regionX: 0, regionY: 0, z: 0 },
], "missing numbers read as 0, as Gson does");
assert.throws(() => parseTiles("{}"));
assert.throws(() => parseTiles("not json"));

// --- Saved packs: tiles replace a pack, visibility only sets it -------------------------------
{
    const merged = mergeSavedPacks(bundled, [
        { id: 2, visible: false },
        { id: 10000, packName: "Mine", packTiles: "[]", visible: true },
        { id: 10001, visible: true },
    ]);
    assert.equal(merged.get(2)?.visible, false);
    assert.equal(merged.get(2)?.packTiles, bundled.get(2)?.packTiles, "bundled tiles kept");
    assert.equal(bundled.get(2)?.visible, true, "the bundled map is not changed");
    assert.equal(merged.get(10000)?.packName, "Mine");
    assert.ok(!merged.has(10001), "a saved custom pack without tiles is dropped");
    assert.equal(writePack({ id: 2, visible: false }), '{"id":2,"visible":false}', "Gson's form, nulls left out");
}

// --- Index: enabled packs only, by region --------------------------------------------------------
{
    const packs = new Map<number, TilePack>([
        [1, { id: 1, packName: "a", visible: true, packTiles: '[{"regionId":1,"regionX":0,"regionY":0,"z":0}]' }],
        [2, { id: 2, packName: "b", visible: true, packTiles: '[{"regionId":1,"regionX":1,"regionY":0,"z":0},{"regionId":2,"regionX":0,"regionY":0,"z":0}]' }],
    ]);
    const index = indexByRegion(packs, [2]);
    assert.deepEqual([...index.keys()], [1, 2]);
    assert.equal(index.get(1)?.length, 1, "pack 1 is off");
}

// --- The custom pack form's checks ----------------------------------------------------------------
assert.equal(customPackError("", "[]"), "Must add a pack name");
assert.equal(customPackError("x", ""), "Must add tiles");
assert.equal(customPackError("x", "[]"), "Error parsing tiles, check the formatting", "an empty list");
assert.equal(customPackError("x", "{"), "Error parsing tiles, check the formatting");
assert.equal(customPackError("x", '[{"regionId":1,"regionX":0,"regionY":0,"z":0}]'), undefined);

// --- Store: enabled packs, custom packs, filters, migration ---------------------------------------
{
    clearConfig();
    const store = new TilePackStore(config);
    store.migrateToLatest();
    assert.equal(config.getConfiguration(PACK_GROUP, "tilePacksVersion"), "2");
    store.load(bundled);
    assert.deepEqual([store.showVisible, store.showInvisible], [true, false], "filter defaults");
    store.addEnabledPack(5);
    store.addEnabledPack(7);
    assert.equal(config.getConfiguration(PACK_GROUP, "packs"), "[5,7]");
    store.removeEnabledPack(5);
    store.removeEnabledPack(7);
    assert.equal(config.getConfiguration(PACK_GROUP, "packs"), undefined, "an empty list is unset");
    const custom = store.addCustomPack("Mine", '[{"regionId":1,"regionX":0,"regionY":0,"z":0}]');
    assert.equal(custom.id, 10000, "custom ids start at 10000");
    assert.equal(config.getConfiguration(PACK_GROUP, "customId"), "10000");
    assert.ok(store.isPackEnabled(10000), "a new custom pack is on");
    assert.equal(store.addCustomPack("Two", "[]").id, 10001);
    store.removeCustomPack(10001);
    assert.equal(config.getConfiguration(PACK_GROUP, "pack_10001"), undefined);
    const two = store.tilePacks.get(2)!;
    two.visible = false;
    store.updatePack(two);
    assert.equal(config.getConfiguration(PACK_GROUP, "pack_2"), '{"id":2,"visible":false}', "a bundled pack saves only its visibility");
    store.setShowInvisible(true);
    const reloaded = new TilePackStore(config);
    reloaded.load(bundled);
    assert.equal(reloaded.tilePacks.get(2)?.visible, false);
    assert.equal(reloaded.tilePacks.get(10000)?.packName, "Mine");
    assert.deepEqual(reloaded.enabledPacks, [10000]);
    assert.deepEqual([reloaded.showVisible, reloaded.showInvisible], [true, true]);

    clearConfig();
    config.setConfiguration(PACK_GROUP, "customPacks", JSON.stringify({ 10000: { id: 10000, packName: "Old", link: "", packTiles: "[]" } }));
    config.setConfiguration(PACK_GROUP, "tilePackConfigs", JSON.stringify({ 3: { packId: 3, visible: false } }));
    new TilePackStore(config).migrateToLatest();
    assert.equal(config.getConfiguration(PACK_GROUP, "pack_10000"), '{"id":10000,"packName":"Old","link":"","packTiles":"[]","visible":true}');
    assert.equal(config.getConfiguration(PACK_GROUP, "pack_3"), '{"id":3,"visible":false}');
    assert.equal(config.getConfiguration(PACK_GROUP, "customPacks"), undefined, "v1 keys removed");
    assert.equal(config.getConfiguration(PACK_GROUP, "tilePackConfigs"), undefined);
}

// --- The plugin ---------------------------------------------------------------------------------
const LUMBRIDGE = (50 << 8) | 50; // region 12850: tiles 3200-3263 x 3200-3263
const packs = new Map<number, TilePack>([
    [1, {
        id: 1, packName: "Lumbridge", visible: true, link: "https://www.youtube.com/watch?v=x",
        packTiles: JSON.stringify([
            { regionId: LUMBRIDGE, regionX: 22, regionY: 18, z: 0, color: "#FFFF0000", label: "Here" },
            { regionId: LUMBRIDGE, regionX: 23, regionY: 18, z: 1, color: "#FF00FF00" },
            { regionId: LUMBRIDGE, regionX: 63, regionY: 63, z: 0, color: "#FF0000FF" },
        ]),
    }],
    [2, { id: 2, packName: "Far away", visible: false, packTiles: JSON.stringify([{ regionId: 1, regionX: 0, regionY: 0, z: 0, color: "#FFFFFFFF" }]) }],
]);

const player = { x: 3222, y: 3218, plane: 0 };
const client: any = {
    gameState: 30,
    controlledPlayerServerId: 1,
    playerEcs: {
        getIndexForServerId: () => 0,
        getX: () => player.x * 128 + 64,
        getY: () => player.y * 128 + 64,
        getLevel: () => player.plane,
    },
    sceneGeometry: {
        tileHeight: () => 0,
        worldToScreen: (x: number, h: number, y: number) => [x * 10, y * 10 + h * 10],
    },
    minimapGeometry: { drawnAt: -1e9, plane: 0, scale: 1, worldToMinimap: (x: number, y: number) => [x, -y] },
};

class FakeToolbar {
    buttons = new Set<unknown>();
    addNavigation(button: unknown) { this.buttons.add(button); }
    removeNavigation(button: unknown) { this.buttons.delete(button); }
}

async function main(): Promise<void> {
    clearConfig();
    ClientState.inInstance = false;
    ClientState.instanceTemplateChunks = null;
    // The 104-tile scene from (3168, 3168) holds regions 49-51 x 49-51.
    ClientState.baseX = 3168;
    ClientState.baseY = 3168;
    const toolbar = new FakeToolbar();
    const plugin = new TilePacksPlugin(client, config, toolbar as any, async () => packs);
    const unlisten = config.addListener((event) => plugin.onConfigChanged(event));
    await plugin.start();
    assert.equal(toolbar.buttons.size, 1, "the sidebar button is added");
    assert.equal(plugin.points.length, 0, "no pack is on yet");
    const [scene, minimap] = plugin.widgetOverlays() as any[];
    assert.equal(scene.signature(), "", "nothing to draw");

    plugin.togglePack(packs.get(1)!);
    assert.deepEqual(plugin.store.enabledPacks, [1]);
    assert.equal(plugin.points.length, 3, "the loaded region's tiles");
    const frame = () => JSON.parse(scene.signature() || "[[],[]]");
    let [shapes, texts] = frame();
    assert.equal(shapes.length, 1, "the other-plane tile is skipped, the far corner is 32+ tiles away");
    assert.deepEqual(shapes[0][0], [[32220, 32180], [32230, 32180], [32230, 32190], [32220, 32190]], "the tile's corners");
    assert.deepEqual(shapes[0][1], [1, 0, 0, 1], "the tile's own colour");
    assert.deepEqual(shapes[0][2], [0, 0, 0, 50 / 255], "fill: black at the fill opacity");
    assert.equal(shapes[0][3], 2, "the border width");
    assert.deepEqual(texts, [["Here", 32225, 32185, 0xffff0000]], "the label at the tile centre");

    config.setConfigValue(TilePacksConfig, "showLabels", false);
    config.setConfigValue(TilePacksConfig, "overrideColorActive", true);
    config.setConfigValue(TilePacksConfig, "overrideColor", 0x8000ffff);
    [shapes, texts] = frame();
    assert.equal(texts.length, 0, "labels off");
    assert.deepEqual(shapes[0][1], [0, 1, 1, 0x80 / 255], "the override colour, with its alpha");
    config.setConfigValue(TilePacksConfig, "overrideColorActive", false);

    player.plane = 1;
    [shapes] = frame();
    assert.deepEqual(shapes[0][1], [0, 1, 0, 1], "on plane 1, the plane-1 tile");
    player.plane = 0;

    // Minimap: off by default; on, a 1px outline, only while the minimap is current.
    assert.equal(minimap.signature(), "");
    config.setConfigValue(TilePacksConfig, "drawTilesOnMinimmap", true);
    assert.equal(minimap.signature(), "", "the minimap was not drawn recently");
    client.minimapGeometry.drawnAt = performance.now();
    const mini = JSON.parse(minimap.signature());
    assert.equal(mini[0].length, 2, "every tile on the plane (no distance limit)");
    assert.deepEqual(mini[0][0][0], [[3222, -3218], [3222, -3219], [3223, -3219], [3223, -3218]]);
    assert.equal(mini[0][0][3], 1);

    // A new scene reloads the points on the next tick.
    ClientState.baseX = 3104;
    plugin.onGameTick();
    assert.equal(plugin.points.length, 3, "region 12850 is still within the scene (3104-3207)");
    ClientState.baseX = 2800;
    plugin.onGameTick();
    assert.equal(plugin.points.length, 0, "out of the scene");
    ClientState.baseX = 3168;
    plugin.onGameTick();
    assert.equal(plugin.points.length, 3);

    // Instances: the template region's tiles at every copy.
    ClientState.inInstance = true;
    ClientState.baseX = 6400;
    ClientState.baseY = 6400;
    const templates = Array.from({ length: 4 }, () => Array.from({ length: 13 }, () => new Array(13).fill(-1)));
    templates[0][2][3] = packTemplateChunk(0, 3216 >> 3, 3216 >> 3, 0);
    ClientState.instanceTemplateChunks = templates;
    plugin.onGameTick();
    assert.deepEqual(plugin.points.map((p) => p.point), [{ x: 6400 + 16 + 6, y: 6400 + 24 + 2, plane: 0 }], "the copied tile");
    const rotated = templates.map((plane) => plane.map((column) => column.slice()));
    rotated[0][2][3] = packTemplateChunk(0, 3216 >> 3, 3216 >> 3, 1);
    ClientState.instanceTemplateChunks = rotated;
    plugin.onGameTick();
    assert.deepEqual(plugin.points.map((p) => p.point), [{ x: 6418, y: 6425, plane: 0 }], "rotation changes reload at the same base and source regions");
    const moved = rotated.map((plane) => plane.map((column) => column.slice()));
    moved[0][2][3] = -1;
    moved[0][4][5] = rotated[0][2][3];
    ClientState.instanceTemplateChunks = moved;
    plugin.onGameTick();
    assert.deepEqual(plugin.points.map((p) => p.point), [{ x: 6434, y: 6441, plane: 0 }], "chunk rearrangements reload too");
    const unchanged = plugin.points;
    plugin.onGameTick();
    assert.equal(plugin.points, unchanged, "an unchanged instance keeps its cached points");
    ClientState.inInstance = false;
    ClientState.instanceTemplateChunks = null;
    ClientState.baseX = 3168;
    ClientState.baseY = 3168;
    plugin.onGameTick();

    // Hide on toolbar.
    config.setConfigValue(TilePacksConfig, "hidePlugin", true);
    assert.equal(toolbar.buttons.size, 0);
    config.setConfigValue(TilePacksConfig, "hidePlugin", false);
    assert.equal(toolbar.buttons.size, 1);

    // The panel: rows filtered by search and by the visible/invisible filters.
    const render = () => renderToStaticMarkup(React.createElement(TilePacksPanel, { plugin }));
    let html = render();
    assert.ok(html.includes("Lumbridge") && !html.includes("Far away"), "hidden packs are filtered out");
    assert.ok(html.includes('title="Remove tiles"'), "an enabled pack offers Remove tiles");
    assert.ok(html.includes('title="Click to open source of pack in browser"'));
    assert.ok(!html.includes('title="Delete this custom pack'), "no delete on bundled packs");
    plugin.setShowInvisible(true);
    html = render();
    assert.ok(html.includes("Far away"));
    assert.ok(html.includes('title="Add tiles"'));
    assert.ok(html.includes("Custom Pack Name") && html.includes("Add Pack") && html.includes("Share in discord"));

    plugin.addCustomPack("My tiles", JSON.stringify([{ regionId: LUMBRIDGE, regionX: 21, regionY: 18, z: 0, color: "#FFFFFFFF" }]));
    assert.equal(plugin.points.length, 4, "a new custom pack is on");
    html = render();
    assert.ok(html.includes("My tiles") && html.includes('title="Delete this custom pack, this is permanent"'));
    plugin.removeCustomPack(plugin.store.tilePacks.get(10000)!);
    assert.equal(plugin.points.length, 3);

    // Copy to clipboard, with the chat message.
    const copied: string[] = [];
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
    const messages: string[] = [];
    const add = chatHistory.addMessage.bind(chatHistory);
    (chatHistory as any).addMessage = (_type: string, text: string) => { messages.push(text); return 0; };
    await plugin.copyTiles(packs.get(1)!);
    (chatHistory as any).addMessage = add;
    assert.deepEqual(copied, [packs.get(1)!.packTiles]);
    assert.deepEqual(messages, ["Lumbridge tiles copied to clipboard"]);

    // Off: no button, nothing drawn.
    await plugin.stop();
    assert.equal(toolbar.buttons.size, 0);
    assert.equal(plugin.widgetOverlays().length, 0);
    unlisten();
    clearConfig();
    console.log("tile-packs tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
