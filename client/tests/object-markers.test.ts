import { strict as assert } from "node:assert";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { packTemplateChunk } from "../common/instance/InstanceTypes";
import { ClientState } from "../game/ClientState";
import { ObjectIndicatorsConfig } from "../game/plugins/objectindicators/ObjectIndicatorsConfig";
import { MARK, ObjectIndicatorsPlugin, UNMARK } from "../game/plugins/objectindicators/ObjectIndicatorsPlugin";
import {
    HF_CLICKBOX,
    HF_HULL,
    colorChoices,
    matchesPoint,
    objectTile,
    parsePoints,
    pointFlags,
    serializePoints,
    type ObjectPoint,
} from "../game/plugins/objectindicators/objectPoints";
import type { SceneLoc } from "../game/scene/SceneGeometry";
import { fromLocalInstance, regionIdOf, rotateInChunk, toLocalInstance } from "../game/scene/worldPoint";
import { locModelParts } from "../render/render/interact/highlight2";
import { getInteractHighlightDrawTargets } from "../render/render/interact/highlight";
import { MenuTargetType } from "../rs/MenuEntry";
import { LocModelType } from "../rs/config/loctype/LocModelType";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";

// --- Points JSON (RuneLite's ObjectPoint), "null" names dropped -----------------------------------
const lumbridge = regionIdOf(3208, 3220);
assert.equal(lumbridge, 12850);
const point: ObjectPoint = { id: 18491, name: "Bank booth", regionId: lumbridge, regionX: 3208 & 63, regionY: 3220 & 63, z: 2, borderColor: 0xffffff00 };
const json = serializePoints([point, { ...point, name: "null", id: 1 }]);
assert.ok(json.includes('"color":"#ffffff00"'), "the border colour is saved as RuneLite's \"color\"");
assert.deepEqual(parsePoints(json).map((p) => p.name), ["Bank booth"]);
assert.equal(parsePoints('[{"id":1,"name":"Door","regionId":1,"regionX":2,"regionY":3,"z":0,"color":{"value":-65536}}]')[0].borderColor,
    0xffff0000, "Gson's {value} colours are read too");
assert.deepEqual(parsePoints("not json"), []);

// Matching: same tile and plane, by id or by (multiloc) name.
const at = { x: 3208, y: 3220, plane: 2 };
assert.ok(matchesPoint(point, 18491, "Bank booth", at));
assert.ok(matchesPoint(point, 99, "Bank booth", at), "another form of the same multiloc");
assert.ok(!matchesPoint(point, 99, "Door", at));
assert.ok(!matchesPoint(point, 18491, "Bank booth", { ...at, plane: 1 }));
assert.equal(pointFlags(point), 0, "no style of its own: the global toggles");
assert.equal(pointFlags({ ...point, hull: true, clickbox: true }), HF_HULL | HF_CLICKBOX);
assert.deepEqual(colorChoices([0xff123456, 0xff123456, undefined], false).slice(0, 2), [0xff123456, 0xffff0000]);
assert.equal(colorChoices([], true)[0], 0x15ff0000, "fill defaults at alpha / 12");

// The saved tile: a game object's centre tile, other objects their own.
assert.deepEqual(objectTile({ x: 10, y: 10, plane: 0 }, LocModelType.NORMAL, 0, 2, 2), { x: 11, y: 11, plane: 0 });
assert.deepEqual(objectTile({ x: 10, y: 10, plane: 0 }, LocModelType.NORMAL, 1, 3, 1), { x: 10, y: 11, plane: 0 }, "sizes swap when rotated");
assert.deepEqual(objectTile({ x: 10, y: 10, plane: 0 }, LocModelType.WALL, 0, 2, 2), { x: 10, y: 10, plane: 0 });

// --- Instance coordinates: RuneLite's fromLocalInstance / toLocalInstance --------------------
for (const rotation of [0, 1, 2, 3]) {
    const templates: number[][][] = [0, 1, 2, 3].map(() => Array.from({ length: 13 }, () => new Array(13).fill(-1)));
    templates[0][2][3] = packTemplateChunk(1, 400, 401, rotation);
    const scene = { templates, baseX: 6400, baseY: 6400 };
    const local = { x: 6400 + 2 * 8 + 5, y: 6400 + 3 * 8 + 1, plane: 0 };
    const template = fromLocalInstance(scene, local);
    assert.equal(template.plane, 1);
    assert.equal(template.x >> 3, 400);
    assert.equal(template.y >> 3, 401);
    assert.deepEqual(toLocalInstance(scene, template), [local], `round trip at rotation ${rotation}`);
}
assert.deepEqual(rotateInChunk({ x: 8, y: 8, plane: 0 }, 1), { x: 8, y: 15, plane: 0 });
assert.deepEqual(fromLocalInstance({ templates: null, baseX: 0, baseY: 0 }, at), at, "outside instances: the tile itself");

// --- Loc models as the scene builds them -------------------------------------------------------
assert.deepEqual(locModelParts(LocModelType.WALL_CORNER, 1, () => undefined).map((p) => p.modelRotation), [5, 2], "a wall corner is two walls");
const outside = locModelParts(LocModelType.WALL_DECORATION_OUTSIDE, 0, () => 20);
assert.deepEqual(outside, [{ modelType: LocModelType.WALL_DECORATION_INSIDE, modelRotation: 0, dx: 20, dz: 0 }]);
const double = locModelParts(LocModelType.WALL_DECORATION_DIAGONAL_DOUBLE, 0, () => undefined);
assert.equal(double.length, 2);
assert.deepEqual([double[0].dx, double[0].dz, double[1].dx], [8, -8, 0], "only the first is displaced (half, diagonally)");
assert.deepEqual(locModelParts(LocModelType.NORMAL, 2, () => undefined), [{ modelType: LocModelType.NORMAL, modelRotation: 2, dx: 0, dz: 0 }]);

// Loc outlines reach the shared outline resolver with Interact Highlight off.
{
    const host: any = {
        interactHighlightDrawTargets: [],
        osrsClient: {
            clientPlugins: {
                locOutlines: () => [{ loc: { id: 1, tileX: 2, tileY: 3, plane: 0, shape: 10, rotation: 0 }, color: 0xffff00, alpha: 1, width: 2 }],
                npcOutlines: () => [],
                interactHighlightConfig: () => undefined,
            },
        },
        buildLocModelHighlightTriangles: (t: any) => (t.locModelType === 10 ? [[0, 0, 0], [1, 0, 0], [0, 1, 0]] : undefined),
    };
    const targets = getInteractHighlightDrawTargets(host);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].color, 0xffff00);
}

// --- The plugin -----------------------------------------------------------------------------------
const BOOTH = 18491, DOOR = 1530, OPEN_DOOR = 1531, GATE = 9000, GATE_OPEN = 9001;
const locTypes: Record<number, any> = {
    [BOOTH]: { name: "Bank booth", sizeX: 1, sizeY: 1 },
    [DOOR]: { name: "Door", sizeX: 1, sizeY: 1 },
    [OPEN_DOOR]: { name: "Door", sizeX: 1, sizeY: 1 },
    [GATE]: { name: "Gate", sizeX: 1, sizeY: 1, transforms: [GATE, GATE_OPEN], transform: () => locTypes[gateForm] },
    [GATE_OPEN]: { name: "Opened gate", sizeX: 1, sizeY: 1 },
};
let gateForm = GATE;
const scene = new Map<string, SceneLoc[]>();
const put = (loc: SceneLoc) => scene.set(`${loc.tileX},${loc.tileY},${loc.plane}`, [loc]);
const booth: SceneLoc = { id: BOOTH, tileX: 3208, tileY: 3220, plane: 2, shape: LocModelType.NORMAL, rotation: 0 };
const door: SceneLoc = { id: DOOR, tileX: 3210, tileY: 3220, plane: 2, shape: LocModelType.WALL, rotation: 0 };
const gate: SceneLoc = { id: GATE, tileX: 3212, tileY: 3220, plane: 2, shape: LocModelType.WALL, rotation: 0 };
for (const loc of [booth, door, gate]) put(loc);
const client: any = {
    gameState: 30,
    locTypeLoader: { load: (id: number) => locTypes[id] },
    varManager: {},
    controlledPlayerServerId: 1,
    playerEcs: { getIndexForServerId: () => 0, getLevel: () => 2 },
    sceneGeometry: {
        tileHeight: () => 0,
        worldToScreen: (x: number, h: number, y: number) => [x * 10, y * 10 + h * 10],
        locModelPoints: (loc: SceneLoc) => (loc.shape === LocModelType.WALL ? [[[loc.tileX, -1, loc.tileY], [loc.tileX + 1, -1, loc.tileY], [loc.tileX, 0, loc.tileY + 0.2]]]
            : [[[loc.tileX, -1, loc.tileY], [loc.tileX + 1, -1, loc.tileY], [loc.tileX + 1, 0, loc.tileY + 1], [loc.tileX, 0, loc.tileY + 1]]]),
        locsAtTile: (x: number, y: number, plane: number) => scene.get(`${x},${y},${plane}`) ?? [],
    },
};

async function main(): Promise<void> {
    const config = inject(ConfigManager);
    ClientState.baseX = 3200 - 48;
    ClientState.baseY = 3200 - 48;
    ClientState.inInstance = false;
    const plugin = new ObjectIndicatorsPlugin(client);
    await plugin.start();
    const examine = (loc: SceneLoc, name: string): SimpleMenuEntry[] => [
        { option: "Bank", target: `<col=00ffff>${name}`, targetType: MenuTargetType.LOC, targetId: loc.id, mapX: loc.tileX - ClientState.baseX, mapY: loc.tileY - ClientState.baseY },
        { option: "Examine", target: `<col=00ffff>${name}`, targetType: MenuTargetType.LOC, targetId: loc.id, mapX: loc.tileX - ClientState.baseX, mapY: loc.tileY - ClientState.baseY },
        { option: "Cancel", target: "" },
    ];
    const world = { surface: "world", menu: true } as const;

    ClientState.setKeybindState(81, false);
    assert.equal(plugin.transformMenuEntries(examine(booth, "Bank booth"), world).length, 3, "Shift only");
    ClientState.setKeybindState(81, true);
    let menu = plugin.transformMenuEntries(examine(booth, "Bank booth"), world);
    assert.deepEqual(menu.map((e) => e.option), ["Bank", MARK, "Examine", "Cancel"]);
    menu[1].onClick!();
    const saved = JSON.parse(config.getConfiguration("objectindicators", `region_${lumbridge}`)!);
    assert.deepEqual([saved[0].id, saved[0].name, saved[0].regionX, saved[0].regionY, saved[0].z], [BOOTH, "Bank booth", 3208 & 63, 3220 & 63, 2]);
    assert.equal(plugin.objects.length, 1);

    menu = plugin.transformMenuEntries(examine(booth, "Bank booth"), world);
    assert.deepEqual(menu.map((e) => e.option), ["Bank", UNMARK, "Mark border color", "Mark fill color", "Mark style", "Examine", "Cancel"]);
    assert.deepEqual(menu[3].subEntries!.map((e) => e.option).slice(-2), ["Pick color", "Reset"]);
    assert.deepEqual(menu[4].subEntries!.map((e) => e.option), ["Hull", "Outline", "Clickbox", "Tile", "Reset"]);

    // Colour suggestions come from loaded regions, including saved marks not currently visible.
    const farRegion = regionIdOf(6400, 6400);
    const neighborRegion = regionIdOf(ClientState.baseX, ClientState.baseY);
    plugin.points.set(farRegion, [{ ...point, regionId: farRegion, borderColor: 0xff123456, fillColor: 0x15123456 }]);
    plugin.points.set(neighborRegion, [{ ...point, regionId: neighborRegion, borderColor: 0xff112233, fillColor: 0x15112233 }]);
    const colorOptions = (index: number) => plugin.transformMenuEntries(examine(booth, "Bank booth"), world)[index].subEntries!.map((e) => e.option);
    assert.ok(!colorOptions(2).includes("<col=123456>Set color"), "distant saved border colours are excluded");
    assert.ok(!colorOptions(3).includes("<col=123456>Set color"), "distant saved fill colours are excluded");
    assert.ok(colorOptions(2).includes("<col=112233>Set color"), "all points in a loaded region can supply colours");
    assert.ok(colorOptions(3).includes("<col=112233>Set color"));

    // Inside an instance, the copied template regions supply the colours, not its local coordinates.
    ClientState.inInstance = true;
    ClientState.instanceTemplateChunks = [0, 1, 2, 3].map(() => Array.from({ length: 13 }, () => new Array(13).fill(-1)));
    ClientState.instanceTemplateChunks[0][0][0] = packTemplateChunk(0, 800, 800, 0);
    assert.ok(colorOptions(2).includes("<col=123456>Set color"), "a loaded template region is included");
    assert.ok(!colorOptions(2).includes("<col=112233>Set color"), "ordinary scene regions are excluded inside instances");
    ClientState.inInstance = false;
    ClientState.instanceTemplateChunks = null;
    plugin.points.delete(farRegion);
    plugin.points.delete(neighborRegion);

    menu[2].subEntries![0].onClick!();
    assert.equal(plugin.objects[0].point.borderColor, 0xffffff00, "the colour in use is offered first");
    menu[2].subEntries![1].onClick!();
    assert.equal(plugin.objects[0].point.borderColor, 0xffff0000);
    menu[4].subEntries![2].onClick!();
    assert.equal(plugin.objects[0].point.clickbox, true);

    // Overlay: the point's own style (clickbox) replaces the global hull; tile on top when toggled.
    const drawnShapeCount = () => {
        let count = 0;
        plugin.widgetOverlay.signature();
        plugin.widgetOverlay.draw({ renderer: { drawPolygon() { count++; } } } as any);
        return count;
    };
    assert.equal(drawnShapeCount(), 1, "clickbox only");
    menu = plugin.transformMenuEntries(examine(booth, "Bank booth"), world);
    menu[4].subEntries![4].onClick!();
    config.setConfigValue(ObjectIndicatorsConfig, "highlightTile", true);
    assert.equal(drawnShapeCount(), 2, "global: hull and tile");
    const originalStringify = JSON.stringify;
    let serializations = 0;
    try {
        JSON.stringify = ((...args: any[]) => { serializations++; return (originalStringify as any)(...args); }) as typeof JSON.stringify;
        const signature = plugin.widgetOverlay.signature();
        assert.equal(plugin.widgetOverlay.signature(), signature, "stationary shapes reuse the repaint signature");
        const project = client.sceneGeometry.worldToScreen;
        client.sceneGeometry.worldToScreen = (x: number, h: number, y: number) => [x * 10 + 10, y * 10 + h * 10];
        assert.notEqual(plugin.widgetOverlay.signature(), signature, "camera movement invalidates the projected shapes");
        client.sceneGeometry.worldToScreen = project;
        assert.equal(serializations, 0, "frame invalidation does not serialize all projected vertices");
    } finally {
        JSON.stringify = originalStringify;
    }
    config.setConfigValue(ObjectIndicatorsConfig, "highlightOutline", true);
    assert.equal(plugin.locOutlines().length, 1);
    plugin.updateObjectConfig(booth, (p) => { p.borderColor = 0x00ff0000; });
    assert.equal(plugin.locOutlines()[0].alpha, 0, "transparent borders do not acquire opaque outlines");
    const oldDocument = globalThis.document;
    const pickerEvents = new Map<string, () => void>();
    const picker = { dataset: {}, style: {}, value: "", remove() {}, showPicker() {},
        addEventListener: (name: string, handler: () => void) => pickerEvents.set(name, handler) };
    try {
        (globalThis as any).document = { querySelectorAll: () => [], createElement: () => picker, body: { appendChild() {} } };
        const borderMenu = plugin.transformMenuEntries(examine(booth, "Bank booth"), world)[2];
        borderMenu.subEntries!.find((entry) => entry.option === "Pick color")!.onClick!();
        picker.value = "#abcdef";
        pickerEvents.get("change")!();
        assert.equal(plugin.objects[0].point.borderColor, 0x00abcdef, "the colour picker preserves zero alpha too");
    } finally {
        if (oldDocument === undefined) delete (globalThis as any).document;
        else (globalThis as any).document = oldDocument;
    }
    plugin.updateObjectConfig(booth, (p) => { p.borderColor = 0x80ff0000; });
    assert.equal(plugin.locOutlines()[0].alpha, 128 / 255, "partial outline transparency is retained");
    plugin.updateObjectConfig(booth, (p) => { p.borderColor = 0xffff0000; });
    config.setConfigValue(ObjectIndicatorsConfig, "highlightOutline", false);
    config.setConfigValue(ObjectIndicatorsConfig, "highlightTile", false);

    // A door: the mark follows its id; opened (another id), it's gone until it closes again.
    plugin.transformMenuEntries(examine(door, "Door"), world)[1].onClick!();
    assert.equal(plugin.objects.length, 2);
    put({ ...door, id: OPEN_DOOR });
    plugin.onGameTick();
    assert.equal(plugin.objects.length, 1);
    put(door);
    plugin.onGameTick();
    assert.equal(plugin.objects.length, 2);

    // A multiloc draws only while its form keeps the marked name.
    plugin.transformMenuEntries(examine(gate, "Gate"), world)[1].onClick!();
    const gateMark = () => plugin.objects.find((o) => o.loc.id === GATE)!;
    assert.ok(plugin.shouldDraw(gateMark()));
    gateForm = GATE_OPEN;
    assert.ok(!plugin.shouldDraw(gateMark()), "now an \"Opened gate\"");
    gateForm = GATE;

    // Unmark removes it and the saved point; another plane isn't drawn.
    menu = plugin.transformMenuEntries(examine(booth, "Bank booth"), world);
    menu[1].onClick!();
    assert.ok(!plugin.objects.some((o) => o.loc.id === BOOTH));
    client.playerEcs.getLevel = () => 0;
    assert.equal(plugin.widgetOverlay.signature(), "");
    client.playerEcs.getLevel = () => 2;
    ClientState.setKeybindState(81, false);

    // Saved marks come back after a restart.
    await plugin.stop();
    await plugin.start();
    assert.equal(plugin.objects.length, 2, "door and gate");
    client.gameState = 10;
    plugin.onGameTick();
    assert.equal(plugin.objects.length, 0, "logged out");
    await plugin.stop();
}

main()
    .then(() => console.log("object markers tests passed"))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
