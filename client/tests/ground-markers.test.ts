import { strict as assert } from "node:assert";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { MenuManager } from "@runelite/client/menus/MenuManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { packTemplateChunk } from "../common/instance/InstanceTypes";
import { ClientState } from "../game/ClientState";
import { GroundMarkerConfig } from "../game/plugins/groundmarkers/GroundMarkerConfig";
import { GroundMarkerPlugin } from "../game/plugins/groundmarkers/GroundMarkerPlugin";
import { mergeImported, parsePoints, serializePoints } from "../game/plugins/groundmarkers/groundMarkerPoints";
import { ORBS_NOMAP_WORLDMAP, ORBS_WORLDMAP } from "../game/plugins/groundmarkers/GroundMarkerSharingManager";
import { chatHistory } from "../rs/cs2/ChatHistory";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";

const config = inject(ConfigManager);
const GROUP = GroundMarkerConfig.group;
const LUMBRIDGE = 12850; // tiles 3200-3263 x 3200-3263

// --- Storage: RuneLite's JSON, as in a RuneLite profile -----------------------------------------
const runeliteJson = '[{"regionId":9624,"regionX":48,"regionY":61,"z":0,"color":"#FFFFFF00","label":"Stand Here"},{"regionId":9624,"regionX":49,"regionY":61,"z":0,"color":"#FF00FF00"}]';
assert.equal(serializePoints(parsePoints(runeliteJson)), runeliteJson, "round trip, byte for byte");
assert.deepEqual(parsePoints('[{"regionId":1,"regionX":2,"regionY":3,"z":0}]'), [{ regionId: 1, regionX: 2, regionY: 3, z: 0 }], "an old tile with no colour");
assert.equal(parsePoints('[{"regionId":1,"regionX":2,"regionY":3,"z":0,"color":{"value":-65536}}]')[0].color, 0xffff0000, "the legacy {value} colour");
assert.throws(() => parsePoints("{}"));
assert.throws(() => parsePoints("nope"));
assert.deepEqual(mergeImported(parsePoints(runeliteJson), [{ regionId: 9624, regionX: 48, regionY: 61, z: 0, color: 1 }]).length, 2, "duplicates by position are skipped");

// --- Fakes ----------------------------------------------------------------------------------------
type Prompt = { kind: "text" | "menu"; title: string; value?: string; onDone?: (v: string) => void; options: [string, () => void][] };
const prompts: Prompt[] = [];
const chatbox: any = {
    openTextInput(title: string) {
        const p: Prompt = { kind: "text", title, options: [] };
        const b: any = { value: (v: string) => ((p.value = v), b), onDone: (f: any) => ((p.onDone = f), b), build: () => (prompts.push(p), b) };
        return b;
    },
    openTextMenuInput(title: string) {
        const p: Prompt = { kind: "menu", title, options: [] };
        const b: any = { option: (t: string, f: () => void) => (p.options.push([t, f]), b), build: () => (prompts.push(p), b) };
        return b;
    },
};
const answer = (option: string) => prompts.pop()!.options.find(([t]) => t === option)![1]();

const messages: string[] = [];
(chatHistory as any).addMessage = (_type: string, text: string) => { messages.push(text); return 0; };
let clipboard: string | Error = "";
Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: {
        writeText: async (t: string) => { clipboard = t; },
        readText: async () => { if (clipboard instanceof Error) throw clipboard; return clipboard; },
    } },
    configurable: true,
});

const player = { x: 3222, y: 3218, plane: 0 };
const client: any = {
    gameState: 30,
    controlledPlayerServerId: 1,
    playerEcs: { getIndexForServerId: () => 0, getX: () => player.x * 128 + 64, getY: () => player.y * 128 + 64, getLevel: () => player.plane },
    sceneGeometry: { tileHeight: () => 0, worldToScreen: (x: number, h: number, y: number) => [x * 10, y * 10 + h * 10] },
    minimapGeometry: { drawnAt: -1e9, plane: 0, scale: 1, worldToMinimap: (x: number, y: number) => [x, -y] },
};

const orbMenu = (): SimpleMenuEntry[] => [
    { option: "Floating World Map", target: "", opcode: 57 },
    { option: "Fullscreen World Map", target: "", opcode: 57 },
    { option: "Cancel", target: "" },
];
const orb = (menus: MenuManager, id = ORBS_WORLDMAP) => menus.apply(orbMenu(), { surface: "widget", menu: true, widgetId: id, childIndex: -1, itemId: -1 });

async function main(): Promise<void> {
    for (const key of config.getConfigurationKeys(`${GROUP}.`)) config.unsetConfiguration(GROUP, key.slice(GROUP.length + 1));
    ClientState.baseX = 3168;
    ClientState.baseY = 3168;
    ClientState.inInstance = false;
    ClientState.instanceTemplateChunks = null;
    const menus = new MenuManager();
    const plugin = new GroundMarkerPlugin(client, { configManager: config, chatboxPanelManager: chatbox, menuManager: menus });
    const unlisten = config.addListener((event) => plugin.onConfigChanged(event));
    assert.equal(GroundMarkerPlugin.descriptor.enabledByDefault, undefined, "on by default, as in RuneLite");
    await plugin.start();

    // The world map orb gets Export / Import / Clear Ground Markers, on both orbs.
    const target = "<col=ff9040>Ground Markers</col>";
    assert.deepEqual(orb(menus).map((e) => `${e.option} ${e.target}`.trim()),
        ["Floating World Map", `Export ${target}`, `Import ${target}`, `Clear ${target}`, "Fullscreen World Map", "Cancel"]);
    assert.equal(orb(menus, ORBS_NOMAP_WORLDMAP).length, 6);

    // The Shift menu on Walk here: (3222, 3218) is scene (54, 50).
    const world = (mapX: number, mapY: number) => plugin.transformMenuEntries(
        [{ option: "Walk here", target: "", mapX, mapY }, { option: "Cancel", target: "" }], { surface: "world", menu: true });
    assert.equal(world(54, 50).length, 2, "nothing without Shift");
    ClientState.setKeybindState(81, true);
    let menu = world(54, 50);
    assert.deepEqual(menu.map((e) => `${e.option} ${e.target}`), ["Mark Tile", "Walk here ", "Cancel "], "just above Walk here");
    ClientState.setKeybindState(82, true);
    assert.deepEqual(world(54, 50).map((e) => e.option), ["Walk here", "Cancel"], "Ctrl+Shift keeps Walk here on top, for the staff teleport");
    ClientState.setKeybindState(82, false);
    menu[0].onClick!();
    assert.equal(config.getConfiguration(GROUP, "region_12850"), '[{"regionId":12850,"regionX":22,"regionY":18,"z":0,"color":"#FFFFFF00"}]',
        "saved as RuneLite saves it, in the marker colour");
    assert.equal(plugin.points.length, 1);

    menu = world(54, 50);
    assert.deepEqual(menu.map((e) => e.option), ["Unmark", "Label", "Color", "Walk here", "Cancel"]);
    assert.deepEqual(menu[2].subEntries!.map((e) => e.option), ["Pick"], "one tile: no Reset all, no other colours");

    // Label: a chatbox text input, prefilled; empty clears it.
    menu[1].onClick!();
    let prompt = prompts.pop()!;
    assert.deepEqual([prompt.kind, prompt.title, prompt.value], ["text", "Tile label", ""]);
    prompt.onDone!("Safe spot");
    assert.equal(plugin.getPoints(LUMBRIDGE)[0].label, "Safe spot");
    world(54, 50)[1].onClick!();
    prompt = prompts.pop()!;
    assert.equal(prompt.value, "Safe spot");
    prompt.onDone!("");
    assert.equal(plugin.getPoints(LUMBRIDGE)[0].label, undefined);

    // A second tile, recoloured: colours in use, Pick, then Reset all (shown in that order).
    world(55, 50)[0].onClick!();
    plugin.colorTile(plugin.getPoints(LUMBRIDGE)[1], 0xffff0000);
    menu = world(54, 50);
    assert.deepEqual(menu[2].subEntries!.map((e) => e.option), ["<col=ff0000>Color", "Pick", "Reset all"]);
    menu[2].subEntries![0].onClick!();
    assert.equal(plugin.getPoints(LUMBRIDGE).find((p) => p.regionX === 22)!.color, 0xffff0000, "a colour in use");
    world(54, 50)[2].subEntries!.find((e) => e.option === "Reset all")!.onClick!();
    assert.equal(prompts.at(-1)!.title, "Are you sure you want to reset the color of 2 tiles?");
    answer("No");
    assert.equal(plugin.getPoints(LUMBRIDGE)[1].color, 0xffff0000, "No leaves them");
    world(54, 50)[2].subEntries!.find((e) => e.option === "Reset all")!.onClick!();
    answer("Yes");
    assert.ok(plugin.getPoints(LUMBRIDGE).every((p) => p.color === 0xffffff00), "Yes resets them to the marker colour");

    // Drawing: the tile, fill and label, on the plane, within 32 tiles; the minimap when on.
    world(54, 50)[1].onClick!();
    prompts.pop()!.onDone!("Here");
    const [scene, minimap] = plugin.widgetOverlays() as any[];
    let [shapes, texts] = JSON.parse(scene.signature());
    assert.equal(shapes.length, 2);
    assert.deepEqual(shapes.find((s: any) => s[0][0][0] === 32220)[0], [[32220, 32180], [32230, 32180], [32230, 32190], [32220, 32190]]);
    assert.deepEqual(shapes[0][1], [1, 1, 0, 1], "yellow");
    assert.deepEqual(shapes[0][2], [0, 0, 0, 50 / 255], "fill opacity");
    assert.deepEqual(texts, [["Here", 32225, 32185, 0xffffff00]]);
    config.setConfiguration(GROUP, "region_12850", '[{"regionId":12850,"regionX":22,"regionY":18,"z":0},{"regionId":12850,"regionX":63,"regionY":63,"z":0},{"regionId":12850,"regionX":23,"regionY":18,"z":1}]');
    plugin.loadPoints();
    [shapes] = JSON.parse(scene.signature());
    assert.equal(shapes.length, 1, "other planes and 32+ tiles away are skipped");
    config.setConfigValue(GroundMarkerConfig, "markerColor", 0x8000ffff);
    [shapes] = JSON.parse(scene.signature());
    assert.deepEqual(shapes[0][1], [0, 1, 1, 0x80 / 255], "a colourless tile draws in the marker colour");
    assert.equal(minimap.signature(), "", "minimap off by default");
    config.setConfigValue(GroundMarkerConfig, "drawTileOnMinimmap", true);
    assert.equal(config.getConfiguration(GROUP, "drawOnMinimap"), "true", "RuneLite's key");
    client.minimapGeometry.drawnAt = performance.now();
    assert.equal(JSON.parse(minimap.signature())[0].length, 2, "every tile on the plane");

    // Export: the loaded regions' points to the clipboard.
    await plugin.sharingManager.exportGroundMarkers();
    assert.equal(clipboard, config.getConfiguration(GROUP, "region_12850"));
    assert.equal(messages.at(-1), "3 ground markers were copied to your clipboard.");

    // Import: into regions not loaded, merged, after the prompt.
    clipboard = runeliteJson;
    await plugin.sharingManager.promptForImport();
    assert.equal(prompts.at(-1)!.title, "Are you sure you want to import 2 ground markers?");
    answer("Yes");
    assert.equal(config.getConfiguration(GROUP, "region_9624"), runeliteJson);
    assert.equal(messages.at(-1), "2 ground markers were imported from the clipboard.");
    await plugin.sharingManager.promptForImport();
    answer("Yes");
    assert.equal(plugin.getPoints(9624).length, 2, "importing again adds no duplicates");
    for (const bad of ["", "not json", "[]"]) {
        clipboard = bad;
        await plugin.sharingManager.promptForImport();
        assert.equal(messages.at(-1), "You do not have any ground markers copied in your clipboard.");
    }
    clipboard = new Error("denied");
    await plugin.sharingManager.promptForImport();
    assert.equal(messages.at(-1), "Unable to read system clipboard.");

    // Clear: the loaded regions only, after the prompt.
    plugin.sharingManager.promptForClear();
    assert.equal(prompts.at(-1)!.title, "Are you sure you want to clear the<br>3 currently loaded ground markers?");
    answer("Yes");
    assert.equal(config.getConfiguration(GROUP, "region_12850"), undefined);
    assert.equal(plugin.getPoints(9624).length, 2, "unloaded regions are kept");
    assert.equal(messages.at(-1), "3 ground markers were cleared.");
    plugin.sharingManager.promptForClear();
    assert.equal(messages.at(-1), "You have no ground markers to clear.");
    await plugin.sharingManager.exportGroundMarkers();
    assert.equal(messages.at(-1), "You have no ground markers to export.");
    world(54, 50)[0].onClick!();
    plugin.sharingManager.promptForClear();
    answer("Yes");
    assert.equal(messages.at(-1), "1 ground marker was cleared.");

    // Show import/export/clear off: the orb options go.
    config.setConfigValue(GroundMarkerConfig, "showImportExport", false);
    assert.equal(orb(menus).length, 3);
    config.setConfigValue(GroundMarkerConfig, "showImportExport", true);
    assert.equal(orb(menus).length, 6);

    // Instances: a mark made in an instance is saved at its real-world tile and drawn at the copy.
    ClientState.inInstance = true;
    ClientState.baseX = 6400;
    ClientState.baseY = 6400;
    const templates = Array.from({ length: 4 }, () => Array.from({ length: 13 }, () => new Array(13).fill(-1)));
    templates[0][2][3] = packTemplateChunk(0, 3216 >> 3, 3216 >> 3, 0);
    ClientState.instanceTemplateChunks = templates;
    player.x = 6400 + 20;
    player.y = 6400 + 26;
    plugin.onGameTick();
    plugin.transformMenuEntries([{ option: "Walk here", target: "", mapX: 16 + 6, mapY: 24 + 2 }], { surface: "world", menu: true })[0].onClick!();
    assert.deepEqual(plugin.getPoints(LUMBRIDGE).map((p) => [p.regionX, p.regionY]), [[22, 18]], "the template tile");
    assert.deepEqual(plugin.points.map((p) => p.worldPoint), [{ x: 6422, y: 6426, plane: 0 }], "drawn at the copy");
    const rotated = templates.map((plane) => plane.map((column) => column.slice()));
    rotated[0][2][3] = packTemplateChunk(0, 3216 >> 3, 3216 >> 3, 1);
    ClientState.instanceTemplateChunks = rotated;
    plugin.onGameTick();
    assert.deepEqual(plugin.points.map((p) => p.worldPoint), [{ x: 6418, y: 6425, plane: 0 }], "rotation changes reload at the same base and source regions");
    const moved = rotated.map((plane) => plane.map((column) => column.slice()));
    moved[0][2][3] = -1;
    moved[0][4][5] = rotated[0][2][3];
    ClientState.instanceTemplateChunks = moved;
    plugin.onGameTick();
    assert.deepEqual(plugin.points.map((p) => p.worldPoint), [{ x: 6434, y: 6441, plane: 0 }], "chunk rearrangements reload too");
    const unchanged = plugin.points;
    plugin.onGameTick();
    assert.equal(plugin.points, unchanged, "an unchanged instance keeps its cached points");
    ClientState.inInstance = false;
    ClientState.instanceTemplateChunks = null;
    ClientState.setKeybindState(81, false);

    await plugin.stop();
    assert.equal(orb(menus).length, 3, "stopping removes the orb options");
    assert.equal(plugin.widgetOverlays().length, 0);
    unlisten();
    console.log("ground-markers tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
