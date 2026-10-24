import assert from "node:assert/strict";
import { test } from "node:test";
import { BuildSteps, finishBuild } from "../common/utils/BuildSteps";
import { Scene } from "../rs/scene/Scene";
import { SceneTile } from "../rs/scene/SceneTile";
import { SceneTileModel } from "../rs/scene/SceneTileModel";
import { SceneBuffer } from "../render/buffer/SceneBuffer";

test("worker steps accept cancellation between units and release unfinished state", async (t) => {
    let clock = 0, units = 0, released = false;
    t.mock.method(performance, "now", () => clock);
    const controller = new AbortController();
    function* build() {
        try {
            for (let i = 0; i < 100; i++) { units++; clock += 4; yield; }
            return "complete";
        } finally { released = true; }
    }
    const work = new BuildSteps(controller.signal).run(build());
    assert.equal(units, 2, "pause after the time budget, before draining the whole square");
    controller.abort();
    await assert.rejects(work, { name: "AbortError" });
    assert.equal(units, 2, "cancellation must not process another unit");
    assert.equal(released, true);
});

test("8x8 terrain steps retain exact geometry, both LODs and border coordinates", async () => {
    const size = 16, border = 6;
    const scene = new Scene(4, size + border * 2, size + border * 2);
    for (let x = 0; x < scene.sizeX; x++) for (let y = 0; y < scene.sizeY; y++) {
        const tile = new SceneTile(0, x, y);
        tile.tileModel = new SceneTileModel(0, 0, -1, x, y, 0, 0, 0, 0,
            96, 96, 96, 96, 10000, 10000, 10000, 10000, 10000, 10000, 0, 0);
        scene.tiles[0][x][y] = tile;
    }
    const whole = new SceneBuffer({} as any, new Map(), 128);
    const stepped = new SceneBuffer({} as any, new Map(), 128);
    const expected = whole.addTerrain(scene, border, 3, size);
    const steps = stepped.addTerrainSteps(scene, border, 3, size);
    assert.equal(steps.next().done, false);
    assert.equal(stepped.indices.length, 0, "the first chunk is a deferred work unit");
    steps.next();
    assert.equal(stepped.drawCommands.length, 1);
    assert.deepEqual(stepped.drawCommands[0].chunk, [0, 0]);
    assert.equal(stepped.drawCommands[0].elements, 8 * 8 * 6, "one step packs one 8x8 chunk");
    assert.equal(await new BuildSteps().run(steps), expected);
    assert.deepEqual(stepped.vertexBuf.byteArray(), whole.vertexBuf.byteArray());
    assert.deepEqual(stepped.indices, whole.indices);
    assert.deepEqual(stepped.drawCommands, whole.drawCommands);
    assert.deepEqual(stepped.drawCommandsLod, whole.drawCommandsLod);
});


test("warm complete square builds preserve every geometry byte and scene metadata", async () => {
    const { CacheSystem } = await import("../rs/cache/CacheSystem");
    const { getCacheLoaderFactory } = await import("../rs/cache/loader/CacheLoaderFactory");
    const { LocModelLoader } = await import("../rs/config/loctype/LocModelLoader");
    const { VarManager } = await import("../rs/config/vartype/VarManager");
    const { SceneBuilder } = await import("../rs/scene/SceneBuilder");
    const { MinimapImageRenderer } = await import("../rs/map/MinimapImageRenderer");
    const { SdMapDataLoader } = await import("../render/loader/SdMapDataLoader");
    const { Hasher } = await import("../common/utils/Hasher");
    const { loadCache, loadCacheInfos, loadCacheList } = await import("../scripts/cache/load-util");
    await Hasher.init();
    const cache = loadCache(loadCacheList(loadCacheInfos()).latest);
    const cacheSystem = CacheSystem.fromFiles(cache.info, cache.files);
    const factory = getCacheLoaderFactory(cache.info, cacheSystem);
    const locTypeLoader = factory.getLocTypeLoader(), textureLoader = factory.getTextureLoader();
    const locModelLoader = new LocModelLoader(locTypeLoader, factory.getModelLoader(), textureLoader,
        factory.getSeqTypeLoader(), factory.getSeqFrameLoader(), factory.getSkeletalSeqLoader());
    const state: any = { cache, cacheSystem, locTypeLoader, textureLoader, locModelLoader,
        varManager: new VarManager(factory.getVarBitTypeLoader()), npcInstances: [],
        sceneBuilder: new SceneBuilder(cache.info, factory.getMapFileLoader(), factory.getUnderlayTypeLoader(),
            factory.getOverlayTypeLoader(), locTypeLoader, locModelLoader, cache.xteas),
        minimapImageRenderer: new MinimapImageRenderer(locTypeLoader, factory.getMapScenes()),
    };
    const loader = new SdMapDataLoader();
    const input = { mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: false, smoothTerrain: true,
        minimizeDrawCalls: true, minimapLevel: 0, loadedTextureIds: new Set<number>() };
    const immediate = new BuildSteps();
    immediate.run = async steps => finishBuild(steps);
    await loader.load(state, input, immediate);
    const expected = await loader.load(state, input, immediate);
    const actual = await loader.load(state, input, new BuildSteps());
    assert.deepEqual(actual.data, expected.data, "yielding cannot change geometry, minimaps, bridge flags or picking metadata");
});

test("pool skips cancelled queued jobs and forwards cancellation to a running worker", async () => {
    const { RenderDataWorkerPool } = await import("../game/worker/RenderDataWorkerPool");
    let dispatch!: (worker: any) => Promise<unknown>;
    const pool = new RenderDataWorkerPool({ queue: (task: typeof dispatch) => { dispatch = task; return {}; } } as any, [], 1);
    const queued = new AbortController();
    pool.queueLoad({} as any, {}, queued.signal);
    queued.abort();
    await assert.rejects(dispatch({ load: () => assert.fail("cancelled jobs never reach a worker") }), { name: "AbortError" });

    const active = new AbortController();
    let requestId: number | undefined, cancelId: number | undefined;
    let reject!: (reason: unknown) => void;
    pool.queueLoad({} as any, {}, active.signal);
    const pending = dispatch({
        load: (_loader: unknown, _input: unknown, id: number) => {
            requestId = id;
            return new Promise((_resolve, no) => { reject = no; });
        },
        cancelLoad: async (id: number) => { cancelId = id; reject(active.signal.reason); },
    });
    active.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(cancelId, requestId, "only the dispatched job is cancelled");
});
