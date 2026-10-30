import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, test } from "node:test";
import { CacheIndexDat2 } from "../rs/cache/CacheIndex";
import { CacheSystem } from "../rs/cache/CacheSystem";
import type { CacheInfo } from "../rs/cache/CacheInfo";
import { Dat2CacheLoaderFactory } from "../rs/cache/loader/Dat2CacheLoaderFactory";
import { ArchiveNpcTypeLoader } from "../rs/config/npctype/NpcTypeLoader";
import { ArchiveLocTypeLoader } from "../rs/config/loctype/LocTypeLoader";
import { ArchiveObjTypeLoader } from "../rs/config/objtype/ObjTypeLoader";
import { crc32 } from "../rs/util/Crc32";
import { getDefinitionArchiveKey, getDefinitionArchives, replaceDefinitionArchives } from "../custom/archives/ArchivedDefinitionStore";
import { cacheKey } from "../game/worker/MapSquareCache";
import type { ArchivedDefinitionBundle } from "../rs/config/ArchivedDefinitionRegistry";
import { loadFromPayload } from "../common/gamemode/GamemodeContentStore";
import { ItemIconRenderer } from "../ui/item/ItemIconRenderer";
import { TextureCache } from "../widgets/gl/texture-cache";
import { GLRenderer } from "../widgets/gl/renderer";

// Client factory/codecs read the actual shipped cache through its production disk store.
const serverRoot = resolve(__dirname, "../../server");
process.chdir(serverRoot);
require(serverRoot + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(serverRoot + "/dist/game/cache/CachePipeline");
const raw = JSON.parse(readFileSync(resolve(serverRoot, "tests/fixtures/archived-seasonal-bundle.json"), "utf8"));
let factory: Dat2CacheLoaderFactory, bundle: ArchivedDefinitionBundle, counts: Record<string, number>, system: CacheSystem;

test('actual archived item pixels and warm GL icons follow installation and removal', () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    // Capture only the Canvas2D presentation boundary; native decoders, models,
    // software rasterizer and both icon-cache owners are real.
    const createCanvas = () => {
        let rgba = new Uint8ClampedArray(36 * 32 * 4);
        const context = {
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: (image: { data: Uint8ClampedArray }) => { rgba = image.data.slice(); },
            getImageData: () => ({ data: rgba.slice() }),
        };
        return { width: 36, height: 32, getContext: () => context } as unknown as HTMLCanvasElement;
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: createCanvas } });
    const items = factory.getObjTypeLoader();
    const install = (rows: ArchivedDefinitionBundle[]) => {
        loadFromPayload({ gamemodeId: 'seasonal', datasets: [{ key: 'definitionArchives', rows }] });
        items.clearCache(); // The actual inbound owner clears the outer type wrapper.
    };
    const makeRenderer = () => new ItemIconRenderer(items, factory.getModelLoader(), factory.getTextureLoader(), system);
    const pixels = (canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(0, 0, 36, 32).data;
    const equalPixels = (a: Int32Array | Uint8ClampedArray, b: Int32Array | Uint8ClampedArray) =>
        a.length === b.length && a.every((value, index) => value === b[index]);
    try {
        install([]);
        const icons = makeRenderer(), plain = icons.renderToCanvas(32926, 1, { quantityMode: 0 });
        assert.ok(plain, 'the actual retired current definition has a drawable cached icon');
        const originalPixels = pixels(plain);
        const deleted: unknown[] = [];
        const glr: any = Object.create(GLRenderer.prototype);
        Object.assign(glr, { textures: new Map(), textureBatchTextures: [], gl: { deleteTexture: (tex: unknown) => deleted.push(tex) } });
        glr.createTextureFromCanvas = (key: string, canvas: HTMLCanvasElement) => {
            const texture = { tex: {}, w: canvas.width, h: canvas.height, pixels: pixels(canvas) };
            glr.textures.set(key, texture); return texture;
        };
        glr.textures.set('unrelated-ui', { tex: {} });
        const textures = new TextureCache(glr, CacheIndexDat2.fromStore(8, CachePipeline.getStore()),
            (id, qty, outline, shadow, quantityMode) => icons.renderToCanvas(id, qty, { outline, shadow, quantityMode }));
        const oldTexture = textures.getItemIconById(32926, 1, 0, 0, 0);
        assert.ok(oldTexture);
        install([bundle]);
        const expected = makeRenderer().renderToCanvas(32926, 1, { quantityMode: 0 });assert.ok(expected);
        assert.equal(equalPixels(pixels(expected), originalPixels), false, 'actual archived platter and retired native item have different pixels');
        const actual = icons.renderToCanvas(32926, 1, { quantityMode: 0 });assert.ok(actual);
        assert.equal(equalPixels(pixels(actual), pixels(expected)), true, 'warm software icon must use the installed definition');
        const newTexture: any = textures.getItemIconById(32926, 1, 0, 0, 0);
        assert.notEqual(newTexture, oldTexture, 'same-id GL item texture must be replaced');
        assert.equal(equalPixels(newTexture.pixels, pixels(expected)), true);
        assert.equal(textures.getItemIconById(32926, 1, 0, 0, 0), newTexture, 'unchanged content reuses its texture');
        assert.ok(glr.getTexture('unrelated-ui'), 'definition changes preserve unrelated UI textures');
        install([]);
        const sprite = icons.createSprite(32926, 1, 0, 0, 0, false, 512);assert.ok(sprite);
        const reference = makeRenderer().createSprite(32926, 1, 0, 0, 0, false, 512);assert.ok(reference);
        assert.equal(equalPixels(sprite.pixels, reference.pixels), true, 'plugin sprite path also follows archive removal');
        const restored: any = textures.getItemIconById(32926, 1, 0, 0, 0);
        assert.notEqual(restored, newTexture);assert.equal(equalPixels(restored.pixels, originalPixels), true);
        assert.ok(deleted.length >= 2, 'old item GPU textures are released');
    } finally {
        install([]);
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete (globalThis as any).document;
    }
});
before(async () => {
    await CachePipeline.initialize(serverRoot);
    const active = CachePipeline.getActive();
    const info: CacheInfo = { name: active.name, game: "oldschool", environment: "live", revision: active.revision, timestamp: active.timestamp, size: 0 };
    const index = CacheIndexDat2.fromStore(2, CachePipeline.getStore());
    const indices = []; for (const id of [0, 1, 2, 3, 7, 8, 9, 22]) indices[id] = CacheIndexDat2.fromStore(id, CachePipeline.getStore());
    system = new CacheSystem(indices);
    const native = {
        npc: new ArchiveNpcTypeLoader(info, index.getArchive(9)),
        loc: new ArchiveLocTypeLoader(info, index.getArchive(6)),
        obj: new ArchiveObjTypeLoader(info, index.getArchive(10)),
    };
    counts = Object.fromEntries(Object.entries(native).map(([kind, loader]) => [kind, loader.getCount()]));
    const next = { ...counts };
    bundle = {
        id: "christmas-2025", targetCache: { name: info.name, game: info.game, revision: info.revision },
        sourceCache: { ...info, name: "osrs-235_2025-12-17", revision: 235, timestamp: "2025-12-17T11:45:07Z" },
        definitions: raw.definitions.map((row: any) => {
            const restored = row.kind === "obj" && row.symbol !== "template_for_placeholder";
            return { kind: row.kind, symbol: row.symbol, sourceId: row.id,
                id: restored ? row.id : next[row.kind]++, dataBase64: row.sourceBytes,
                crc: crc32(Int8Array.from(Buffer.from(row.sourceBytes, "base64"))),
                ...(restored ? { expectedCurrentCrc: crc32(native.obj.archive.getFile(row.id)!.data) } : {}),
            };
        }),
    };
    factory = new Dat2CacheLoaderFactory(info, "dat2", system);
});

test("actual client factory restores the native platter and morphs without replacing live NPC identities", () => {
    replaceDefinitionArchives([]);
    const npcs = factory.getNpcTypeLoader(), items = factory.getObjTypeLoader();
    const scurrius = npcs.load(15548);
    assert.equal(scurrius.name, "Scurrius");
    assert.equal(items.load(32926).name, "Null");
    const input = { mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: false,
        smoothTerrain: true, minimizeDrawCalls: true, loadedTextureIds: new Set<number>() };
    const ordinaryKey = cacheKey(bundle.sourceCache, input, "", getDefinitionArchiveKey());
    loadFromPayload({ gamemodeId: "seasonal", datasets: [{ key: "definitionArchives", rows: [bundle] }] });
    assert.notEqual(cacheKey(bundle.sourceCache, input, "", getDefinitionArchiveKey()), ordinaryKey,
        'archived loc definitions also invalidate persisted squares built without NPCs');
    items.clearCache(); // The inbound content owner clears its actual outer wrapper.
    const root = bundle.definitions.find(row => row.symbol === "xmas25_queue_npc_1")!;
    assert.equal(npcs.load(root.id).transform({ getVarbit: () => 0, getVarp: () => 0 }, npcs)!.name, "Sir Prysin");
    assert.equal(npcs.load(root.id).transform({ getVarbit: () => 1, getVarp: () => 0 }, npcs)!.name, "Aggie");
    assert.equal(npcs.load(15548), scurrius);
    assert.equal(items.load(32926).name, "Serving platter");
    assert.equal(items.load(32927).name, "Serving platter");
    assert.equal(npcs.getCount(), counts.npc + 32);
    // The transport snapshot is owned by the store; callers cannot rewrite its bytes.
    const snapshot = getDefinitionArchives(); snapshot[0].definitions[0].dataBase64 = "AA==";
    assert.notEqual(getDefinitionArchives()[0].definitions[0].dataBase64, "AA==");
    replaceDefinitionArchives([]); items.clearCache(); npcs.clearCache();
    assert.equal(cacheKey(bundle.sourceCache, input, "", getDefinitionArchiveKey()), ordinaryKey);
    assert.equal(items.load(32926).name, "Null");
    assert.equal(npcs.getCount(), counts.npc);
    assert.equal(npcs.load(15548).name, "Scurrius");
});

test("a stale target snapshot is rejected by the real factory before any archived type is returned", () => {
    const stale = JSON.parse(JSON.stringify(bundle)); stale.targetCache.revision--;
    replaceDefinitionArchives([stale]);
    assert.throws(() => factory.getNpcTypeLoader().getCount(), /target|cache/i);
    replaceDefinitionArchives([]);
    assert.equal(factory.getNpcTypeLoader().getCount(), counts.npc);
});

test("both real renderer invalidators replace cached native chatheads and already baked widget portraits", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    delete (globalThis as any).window; delete (globalThis as any).document;
    (globalThis as any).self = globalThis;
    require.extensions['.glsl'] = (module: any, file: string) => { module.exports = readFileSync(file, 'utf8'); };
    for (const ext of ['.png', '.jpg', '.webp']) require.extensions[ext] = (module: any, file: string) => { module.exports = file; };
    const { WebGLOsrsRenderer } = require('../render/WebGLOsrsRenderer');
    const { WebGPURenderer } = require('../render/webgpu/WebGPURenderer');
    const { WebGPUUi } = require('../render/webgpu/ui/WebGPUUi');
    const { ChatheadFactory } = require('../render/ChatheadFactory');
    const { WidgetsOverlay } = require('../ui/devoverlay/WidgetsOverlay');
    const { GLRenderer } = require('../widgets/gl/renderer');
    const { WidgetManager } = require('../widgets/WidgetManager');
    const { VarManager } = require('../rs/config/vartype/VarManager');
    const id = counts.npc, types = factory.getNpcTypeLoader();
    const install = (symbol: string) => {
        const row = bundle.definitions.find(row => row.symbol === symbol)!;
        const input = { ...bundle, definitions: [{ ...row, id }] };
        loadFromPayload({ gamemodeId: 'seasonal', datasets: [{ key: 'definitionArchives', rows: [input] }] });
        types.clearCache();
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        head: { appendChild() {} }, querySelectorAll: () => [],
        createElement: () => ({ style: {}, dataset: {}, tabIndex: 0, sheet: { cssRules: [], insertRule() { return 0; } }, setAttribute() {}, appendChild() {} }),
    } });
    try {
        for (const Backend of [WebGLOsrsRenderer, WebGPURenderer]) {
            install('xmas25_sir_prysin');
            const client: any = { workerPool: { size: 1 }, npcTypeLoader: types, modelLoader: factory.getModelLoader(), textureLoader: factory.getTextureLoader(),
                seqTypeLoader: factory.getSeqTypeLoader(), seqFrameLoader: factory.getSeqFrameLoader(), skeletalSeqLoader: factory.getSkeletalSeqLoader(),
                varManager: new VarManager(factory.getVarBitTypeLoader()), widgetManager: new WidgetManager(system) };
            const renderer: any = new Backend(client);
            const chatheads = new ChatheadFactory(client.modelLoader, client.textureLoader);
            const old = chatheads.get(types.load(id)); assert.ok(old);
            const widgets: any = new WidgetsOverlay(undefined, { getWidgetManager: () => client.widgetManager });
            const canvas: any = { __modelRenderCache: new Map([['wm:portrait', { tex: {}, offsetX: 0, offsetY: 0, w: 50, h: 50 }]]),
                __animatedModelMemo: new Map([[42, { key: 'old', tex: {}, offsetX: 0, offsetY: 0, w: 50, h: 50 }]]) };
            const deleted: unknown[] = [];
            const glr: any = Object.create(GLRenderer.prototype);
            Object.assign(glr, { canvas, textures: new Map([['wm:portrait', { tex: {} }], ['wm:dyn:42', { tex: {} }], ['unrelated-ui', { tex: {} }]]),
                textureBatchTextures: [], gl: { deleteTexture: (texture: unknown) => deleted.push(texture) } });
            widgets.glRenderer = glr; widgets.hasPresentedFrame = true; client.widgetManager.globalDirty = false;
            if (Backend === WebGLOsrsRenderer) { renderer.chatheadFactory = chatheads; renderer.widgetsOverlay = widgets; }
            else {
                const ui: any = new WebGPUUi(renderer);
                // Headless presentation context. Cache/model/widget owners and both
                // renderer methods are real; DOM/GPU presentation init is not exercised.
                ui.widgetsHost = { osrsClient: client, chatheadFactory: chatheads }; ui.widgetsOverlay = widgets; renderer.ui = ui;
            }
            install('xmas25_aggie');
            const aggie = types.load(id); assert.equal(aggie.name, 'Aggie');
            assert.equal(chatheads.get(aggie), old, 'real cached model reproduces the same-ID stale portrait before invalidation');
            renderer.invalidateDefinitionCaches();
            const actual = chatheads.get(aggie), expected = new ChatheadFactory(client.modelLoader, client.textureLoader).get(aggie);
            assert.ok(actual && expected); assert.notEqual(actual, old);
            assert.deepEqual(actual.verticesX, expected.verticesX); assert.deepEqual(actual.verticesY, expected.verticesY);
            assert.equal(canvas.__modelRenderCache.size, 0); assert.equal(canvas.__animatedModelMemo.size, 0);
            assert.equal(deleted.length, 2); assert.ok(glr.getTexture('unrelated-ui'));
            assert.equal(client.widgetManager.globalDirty, true); assert.equal(widgets.hasPresentedFrame, false);
        }
    } finally {
        replaceDefinitionArchives([]); types.clearCache();
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete (globalThis as any).window;
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete (globalThis as any).document;
    }
});
