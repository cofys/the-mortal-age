import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { SdMapDataLoader } from "../render/loader/SdMapDataLoader";
import { snapshotMapInput, type SdMapLoaderInput } from "../render/loader/SdMapLoaderInput";
import { SceneBuffer } from "../render/buffer/SceneBuffer";
import { Scene } from "../rs/scene/Scene";
import { LocLoadType } from "../rs/scene/SceneBuilder";
import { SceneBuilder } from "../rs/scene/SceneBuilder";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../rs/config/loctype/LocModelLoader";
import { MinimapImageRenderer } from "../rs/map/MinimapImageRenderer";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

function emptyState(levels: number[], types: LocLoadType[]) {
    return {
        cache: { info: { name: "test", game: "oldschool" } },
        cacheSystem: { getIndex: () => ({ archiveExists: () => false }) },
        textureLoader: { getTextureIds: () => [], isSd: () => true },
        locTypeLoader: { load: () => undefined },
        sceneBuilder: {
            mapFileLoader: { setRegionReplacements() {} },
            clearLocOverrides() {}, clearLocSpawns() {}, clearTerrainOverrides() {},
            *buildSceneSteps(_x: number, _y: number, _w: number, _h: number, _smooth: boolean, type: LocLoadType) {
                types.push(type);
                return new Scene(4, 76, 76);
            },
        },
        minimapImageRenderer: { renderMinimap(_scene: Scene, level: number) {
            levels.push(level);
            return new Int32Array(304 * 304);
        } },
    } as any;
}

const input: SdMapLoaderInput = {
    mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: false, smoothTerrain: false,
    minimizeDrawCalls: true, loadedTextureIds: new Set(),
};

test("foreground maps rasterize only the requested floor; a later floor skips geometry", async (t) => {
    const globals = globalThis as any;
    const before = { OffscreenCanvas: globals.OffscreenCanvas, ImageData: globals.ImageData };
    t.after(() => Object.assign(globals, before));
    globals.ImageData = class { data: Uint8ClampedArray; constructor(w: number, h: number) { this.data = new Uint8ClampedArray(w * h * 4); } };
    globals.OffscreenCanvas = class {
        getContext() { return { putImageData() {} }; }
        async convertToBlob() { return new Blob(["minimap"]); }
    };
    const levels: number[] = [], types: LocLoadType[] = [];
    const state = emptyState(levels, types), loader = new SdMapDataLoader();
    const built = await loader.load(state, { ...input, minimapLevel: 2 });
    assert.deepEqual(levels, [2], "three other floor rasters must not delay map readiness");
    assert.equal(built.data?.minimapBlobs?.length, 4);
    assert.equal(built.data?.minimapBlobs?.[0], undefined);
    assert.ok(built.data?.minimapBlobs?.[2] instanceof Blob);

    levels.length = 0;
    t.mock.method(SceneBuffer.prototype, "addTerrainSteps", () => assert.fail("a minimap floor never repacks terrain"));
    state.textureLoader.getTextureIds = () => assert.fail("a minimap floor never collects geometry textures");
    const floor = await loader.load(state, { ...input, minimapOnly: true, minimapLevel: 1 });
    assert.deepEqual(levels, [1]);
    assert.equal(types.at(-1), LocLoadType.NO_MODELS);
    assert.deepEqual(Object.keys(floor.data!).sort(), ["mapX", "mapY", "minimapBlobs"]);
    assert.ok(floor.data?.minimapBlobs[1] instanceof Blob);
});

test("minimap input preserves submitted dynamic values when the renderer changes them", () => {
    const change = { newId: 3, moveToX: 3250 };
    const spawn = { id: 5, type: 10, rotation: 0 };
    const terrain = { overlay: 7 };
    const region = { terrainData: Int8Array.of(1) };
    const extra = { id: 6, x: 3210, y: 3220, level: 0, shape: 10, rotation: 1 };
    const submitted = snapshotMapInput({ ...input,
        locOverrides: new Map([["1,2,0,3", change]]), locSpawns: new Map([["1,2,0", spawn]]),
        terrainOverrides: new Map([["1,2,0", terrain]]), mapRegionReplacements: new Map([[1, region]]), extraLocs: [extra],
    });
    change.newId = 99; spawn.rotation = 2; terrain.overlay = 9; extra.x = 3200;
    region.terrainData = Int8Array.of(2);
    assert.equal(submitted.locOverrides?.get("1,2,0,3")?.newId, 3);
    assert.equal(submitted.locSpawns?.get("1,2,0")?.rotation, 0);
    assert.equal(submitted.terrainOverrides?.get("1,2,0")?.overlay, 7);
    assert.equal(submitted.extraLocs?.[0].x, 3210);
    assert.equal(submitted.mapRegionReplacements?.get(1)?.terrainData[0], 1);
});

test("metadata-only minimaps retain every floor and the Lumbridge bridge raster", () => {
    const info = loadCacheList(loadCacheInfos()).latest, cache = loadCache(info);
    const factory = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, cache.files));
    const types = factory.getLocTypeLoader();
    const models = new LocModelLoader(types, factory.getModelLoader(), factory.getTextureLoader(),
        factory.getSeqTypeLoader(), factory.getSeqFrameLoader(), factory.getSkeletalSeqLoader());
    const builder = new SceneBuilder(info, factory.getMapFileLoader(), factory.getUnderlayTypeLoader(),
        factory.getOverlayTypeLoader(), types, models, cache.xteas);
    const renderer = new MinimapImageRenderer(types, factory.getMapScenes());
    for (const [mapX, mapY] of [[50, 50], [48, 52]]) {
        const full = builder.buildScene(mapX * 64 - 6, mapY * 64 - 6, 76, 76, true, LocLoadType.MODELS);
        const metadata = builder.buildScene(mapX * 64 - 6, mapY * 64 - 6, 76, 76, true, LocLoadType.NO_MODELS);
        for (let floor = 0; floor < 4; floor++) {
            assert.deepEqual(renderer.renderMinimap(metadata, floor), renderer.renderMinimap(full, floor),
                `${mapX},${mapY} floor ${floor} has the same raster without packing loc models`);
        }
    }
});

test("missing floor requests deduplicate, retry after failure and reject replaced scenes", async (t) => {
    (globalThis as any).self = globalThis;
    require.extensions[".glsl"] = (module, file) => { module.exports = fs.readFileSync(file, "utf8"); };
    for (const ext of [".png", ".jpg", ".webp"]) require.extensions[ext] = (module, file) => { module.exports = file; };
    const { GameRenderer } = require("../game/GameRenderer");
    const resolves: Array<(value: any) => void> = [], rejects: Array<(value: Error) => void> = [];
    const installed: Array<[number, number, string | undefined, number]> = [];
    const renderer: any = Object.create(GameRenderer.prototype);
    renderer.minimapSources = new Map(); renderer.minimapRequests = new Map();
    renderer.osrsClient = {
        inputManager: { cleanUp() {} },
        setMinimapImageUrl: (...args: any[]) => installed.push(args as any),
        workerPool: { queueMinimap: () => new Promise((resolve, reject) => { resolves.push(resolve); rejects.push(reject); }) },
    };
    renderer.registerMinimapSource({ mapX: 50, mapY: 50, minimapInput: input });
    installed.length = 0;
    const first = renderer.requestMinimapImage(50, 50, 1);
    await renderer.requestMinimapImage(50, 50, 1);
    assert.equal(resolves.length, 1);
    renderer.registerMinimapSource({ mapX: 50, mapY: 50, minimapInput: input });
    installed.length = 0;
    resolves[0]({ minimapBlobs: [undefined, new Blob(["stale"])] });
    await first;
    assert.equal(installed.length, 0, "a previous scene's floor must not overwrite its replacement");

    const second = renderer.requestMinimapImage(50, 50, 1);
    resolves[1]({ minimapBlobs: [undefined, new Blob(["current"])] });
    await second;
    assert.equal(installed.length, 1);
    URL.revokeObjectURL(installed[0][2]!);
    t.mock.method(console, "warn", () => {});
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const failed = renderer.requestMinimapImage(50, 50, 2);
    rejects[2](new Error("temporary cache failure"));
    await failed;
    await renderer.requestMinimapImage(50, 50, 2);
    assert.equal(resolves.length, 3, "a failure must not retry every HUD frame");
    now += 1001;
    const retried = renderer.requestMinimapImage(50, 50, 2);
    assert.equal(resolves.length, 4);
    renderer.clearMinimapSources();
    resolves[3]({ minimapBlobs: [undefined, undefined, new Blob(["cleared"])] });
    await retried;
    assert.equal(installed.length, 1, "instance/logout cleanup invalidates in-flight replies");
    assert.equal(renderer.minimapRequests.size, 0);

    renderer.registerMinimapSource({ mapX: 50, mapY: 50, minimapInput: input });
    installed.length = 0;
    const stopped = renderer.requestMinimapImage(50, 50, 3);
    GameRenderer.prototype.cleanUp.call(renderer);
    resolves[4]({ minimapBlobs: [undefined, undefined, undefined, new Blob(["stopped"])] });
    await stopped;
    assert.equal(installed.length, 0, "a stopped renderer must not publish floors after a backend switch");
});
