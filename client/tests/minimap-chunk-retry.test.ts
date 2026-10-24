import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { runWithSparseRetry } from "../game/worker/SparseRetry";
import { GroupMissingError } from "../rs/cache/js5/GroupMissingError";
import type { GroupSpan } from "../rs/cache/store/SparseMemoryStore";
import { SceneBuffer } from "../render/buffer/SceneBuffer";
import { SdMapDataLoader } from "../render/loader/SdMapDataLoader";
import { Scene } from "../rs/scene/Scene";
import { LocEntity } from "../rs/scene/entity/LocEntity";
import { LocModelType } from "../rs/config/loctype/LocModelType";
import { calculateEntityTag, EntityType } from "../rs/scene/entity/EntityTag";

function sparseCache() {
    const present = new Set<number>();
    const pending = new Set<number>();
    const store = {
        missCount: 0,
        onMiss: (span: GroupSpan) => { pending.add(span.archiveId); },
        isGroupPresent: (_index: number, archive: number) => present.has(archive),
    };
    const js5 = {
        store,
        requestGroup: async (_index: number, archive: number) => { present.add(archive); pending.delete(archive); },
        settled: async () => { for (const archive of pending) present.add(archive); pending.clear(); },
    };
    const missing = (archive: number) => {
        if (present.has(archive)) return false;
        store.missCount++;
        store.onMiss({ indexId: 7, archiveId: archive, startByte: 0, byteLength: 520 } as GroupSpan);
        return true;
    };
    return { state: { js5 } as any, js5, missing };
}

test("worker rebuilds minimap data after a missing terrain chunk arrives", async () => {
    const cache = sparseCache();
    const outcome = { complete: false };
    const listener = cache.js5.store.onMiss;
    let attempts = 0;

    const result = await runWithSparseRetry(
        cache.state,
        async () => {
            attempts++;
            if (cache.missing(1)) return { minimapBlobs: [] };
            return { minimapBlobs: [new Uint8Array([1, 2, 3])] };
        },
        undefined,
        outcome,
    );

    assert.equal(attempts, 2);
    assert.deepEqual(result.minimapBlobs, [new Uint8Array([1, 2, 3])]);
    assert.equal(outcome.complete, true);
    assert.equal(cache.js5.store.onMiss, listener, "the coordinator's miss listener is restored");
});

test("worker waits for every dependency beyond eight download waves", async () => {
    const cache = sparseCache();
    let attempts = 0;
    const outcome = { complete: false };
    const result = await runWithSparseRetry(cache.state, async () => {
        attempts++;
        for (let group = 0; group < 12; group++) {
            if (cache.missing(group)) return { geometry: "incomplete" };
        }
        return { geometry: "complete" };
    }, undefined, outcome);
    assert.equal(attempts, 13);
    assert.equal(result.geometry, "complete", "incomplete geometry must never leave the worker");
    assert.equal(outcome.complete, true);
});

test("sparse map loads wait for missing scene models before baking geometry and minimaps", async (t) => {
    const cache = sparseCache();
    let attempts = 0, terrainBakes = 0;
    const addTerrain = SceneBuffer.prototype.addTerrainSteps;
    t.mock.method(SceneBuffer.prototype, "addTerrainSteps", function (
        this: SceneBuffer, ...args: Parameters<SceneBuffer["addTerrainSteps"]>
    ) {
        terrainBakes++;
        return addTerrain.apply(this, args);
    });
    const state: any = {
        ...cache.state,
        cache: { info: { name: "test", game: "oldschool" } },
        cacheSystem: { getIndex: () => ({ archiveExists: () => false }) },
        textureLoader: { getTextureIds: () => [], isSd: () => true },
        sceneBuilder: {
            mapFileLoader: { setRegionReplacements() {} },
            clearLocOverrides() {}, clearLocSpawns() {}, clearTerrainOverrides() {},
            *buildSceneSteps() {
                attempts++;
                for (const model of [1, 2]) if (cache.missing(model)) break;
                return new Scene(4, 76, 76);
            },
        },
    };
    const loader = new SdMapDataLoader();
    const outcome = { complete: false };
    const result = await runWithSparseRetry(state, () => loader.load(state, {
        mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: false, smoothTerrain: false,
        minimizeDrawCalls: true, loadedTextureIds: new Set(),
    }), undefined, outcome);
    assert.equal(attempts, 3, "the cold cache still discovers both dependency waves");
    assert.equal(terrainBakes, 1, "incomplete scene passes must skip discarded geometry and minimap work");
    assert.equal(result.data?.minimapBlobs.length, 4, "the completed build still includes every minimap plane");
    assert.equal(outcome.complete, true, "only a complete scene can leave the worker");
});

test("animation dependency retries do not repeatedly pack terrain", async (t) => {
    const cache = sparseCache();
    let terrainBakes = 0, attempts = 0;
    let blocking = true, group = 1, lateTexture = false;
    const addTerrain = SceneBuffer.prototype.addTerrainSteps;
    t.mock.method(SceneBuffer.prototype, "addTerrainSteps", function (
        this: SceneBuffer, ...args: Parameters<SceneBuffer["addTerrainSteps"]>
    ) {
        terrainBakes++;
        if (lateTexture) this.usedTextureIds.add(1);
        return addTerrain.apply(this, args);
    });
    const locType = { id: 1, name: "flag", sizeX: 1, sizeY: 1, mapFunctionId: -1 };
    const state: any = {
        ...cache.state,
        cache: { info: { name: "test", game: "oldschool" } },
        cacheSystem: { getIndex: () => ({ archiveExists: () => false }) },
        textureLoader: {
            getTextureIds: () => [1], isSd: () => true,
            getPixelsArgb: () => {
                if (cache.missing(group + 1)) throw new GroupMissingError(7, group + 1, 0, 520);
                return new Int32Array([1]);
            },
        },
        locTypeLoader: { load: () => locType },
        locModelLoader: {
            locTypeLoader: { load: () => locType },
            seqTypeLoader: { load: () => ({ isSkeletalSeq: () => false, frameIds: [1] }) },
            getModelAnimated: () => {
                if (cache.missing(group) && blocking) throw new GroupMissingError(7, group, 0, 520);
                return undefined;
            },
        },
        sceneBuilder: {
            mapFileLoader: { setRegionReplacements() {} },
            clearLocOverrides() {}, clearLocSpawns() {}, clearTerrainOverrides() {},
            *buildSceneSteps() {
                attempts++;
                const scene = new Scene(4, 76, 76);
                const entity = new LocEntity(1, LocModelType.FLOOR_DECORATION, 0, 0, 12, 12, 1, false);
                scene.newFloorDecoration(0, 12, 12, 0, entity,
                    calculateEntityTag(12, 12, EntityType.LOC, false, 1), LocModelType.FLOOR_DECORATION);
                return scene;
            },
        },
    };
    const loader = new SdMapDataLoader();
    const load = () => runWithSparseRetry(state, () => loader.load(state, {
        mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: false, smoothTerrain: false,
        minimizeDrawCalls: true, loadedTextureIds: new Set(),
    }));
    let result = await load();
    assert.equal(attempts, 2);
    assert.equal(terrainBakes, 1, "a missing animation frame must yield before packing unchanged terrain");
    assert.equal(result.data?.minimapBlobs.length, 4);

    blocking = false;
    group++;
    terrainBakes = attempts = 0;
    result = await load();
    assert.equal(attempts, 2);
    assert.equal(terrainBakes, 1, "a swallowed animation miss must also skip discarded output work");

    lateTexture = true;
    group++;
    terrainBakes = attempts = 0;
    result = await load();
    assert.equal(attempts, 3, "a texture discovered after the checkpoint still receives its own retry");
    assert.equal(result.data?.loadedTextures.has(1), true, "the final output must contain the later texture");
});

test("blocking group downloads recover from transient fetch errors", async (t) => {
    t.mock.method(console, "warn", () => {});
    const cache = sparseCache();
    const request = cache.js5.requestGroup;
    let requests = 0;
    cache.js5.requestGroup = async (index, archive) => {
        if (++requests < 3) throw new Error("temporary fetch failure");
        return request(index, archive);
    };
    const result = await runWithSparseRetry(cache.state, async () => {
        if (cache.missing(1)) throw new GroupMissingError(7, 1, 0, 520);
        return "complete";
    });
    assert.equal(requests, 3);
    assert.equal(result, "complete");
});

test("permanently missing groups fail instead of publishing a partial scene", async () => {
    const cache = sparseCache();
    cache.js5.settled = async () => {};
    const listener = cache.js5.store.onMiss;
    const outcome = { complete: false };
    let attempts = 0;
    await assert.rejects(runWithSparseRetry(cache.state, async () => {
        attempts++;
        cache.missing(1);
        return { geometry: "incomplete" };
    }, undefined, outcome), /Incomplete build: no download progress after 8 attempts \(7:1\)/);
    assert.equal(attempts, 8);
    assert.equal(outcome.complete, false);
    assert.equal(cache.js5.store.onMiss, listener);
});

test("lost coordinator replies yield the worker within the total retry budget", async (t) => {
    t.mock.method(console, "warn", () => {});
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const advance = async (ms: number) => {
        now += ms;
        t.mock.timers.tick(ms);
        await setImmediate();
    };
    const cache = sparseCache();
    cache.js5.settled = () => new Promise(() => {});
    const listener = cache.js5.store.onMiss;
    const outcome = { complete: true };
    let attempts = 0, failure: Error | undefined;
    const result = runWithSparseRetry(cache.state, async () => {
        attempts++;
        cache.missing(1);
        return "incomplete";
    }, undefined, outcome);
    void result.catch(error => { failure = error; });
    await setImmediate();
    await advance(3000);
    await advance(250);
    assert.equal(attempts, 2, "a lost reply must not monopolize one 30-second wait");
    while (now < 15000) await advance(Math.min(250, 15000 - now));
    assert.match(failure?.message ?? "", /Incomplete build: retry deadline/);
    await assert.rejects(result, /Incomplete build: retry deadline/);
    assert.equal(outcome.complete, false);
    assert.equal(cache.js5.store.onMiss, listener);
});

test("new dependency progress cannot extend the worker's total retry deadline", async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const cache = sparseCache();
    const settled = cache.js5.settled;
    cache.js5.settled = async () => { await settled(); now += 1000; };
    const listener = cache.js5.store.onMiss;
    const outcome = { complete: true };
    let attempts = 0;
    await assert.rejects(runWithSparseRetry(cache.state, async () => {
        if (++attempts <= 20) cache.missing(attempts);
        return attempts <= 20 ? "incomplete" : "complete";
    }, undefined, outcome), /Incomplete build: retry deadline/);
    assert.equal(attempts, 15, "advancing groups must not reset the total budget");
    assert.equal(outcome.complete, false);
    assert.equal(cache.js5.store.onMiss, listener);

    let followUpAttempts = 0;
    const result = await runWithSparseRetry(cache.state, async () => {
        followUpAttempts++;
        for (let group = 1; group <= 20; group++) if (cache.missing(group)) return "incomplete";
        return "complete";
    }, undefined, outcome);
    assert.equal(result, "complete", "renderer rescheduling can finish using the bytes already downloaded");
    assert.equal(followUpAttempts, 6, "a failed budget must not discard downloaded groups or poison later work");
    assert.equal(outcome.complete, true);
    assert.equal(cache.js5.store.onMiss, listener);
});

test("cache waits and backoff use only the retry time left after building geometry", async (t) => {
    t.mock.method(console, "warn", () => {});
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    t.mock.method(performance, "now", () => now);
    for (const [buildMs, lostReply] of [[14000, true], [14900, false]] as const) {
        now = 0;
        const cache = sparseCache();
        cache.js5.settled = () => lostReply ? new Promise(() => {}) : Promise.resolve();
        let failure: Error | undefined;
        const result = runWithSparseRetry(cache.state, async () => {
            now += buildMs;
            cache.missing(1);
            return "incomplete";
        });
        void result.catch(error => { failure = error; });
        await setImmediate();
        const remaining = 15000 - now;
        now += remaining - 1;
        t.mock.timers.tick(remaining - 1);
        await setImmediate();
        assert.equal(failure, undefined, "the final wait still has time to finish");
        now++;
        t.mock.timers.tick(1);
        await setImmediate();
        assert.match(failure?.message ?? "", /Incomplete build: retry deadline/);
        await assert.rejects(result, /Incomplete build: retry deadline/);
    }
});

test("an asynchronous pass beyond the deadline is accepted only when its geometry is complete", async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    for (const complete of [false, true]) {
        now = 0;
        const cache = sparseCache();
        const outcome = { complete: false };
        const result = runWithSparseRetry(cache.state, async () => {
            await setImmediate();
            now = 16000;
            if (!complete) cache.missing(1);
            return complete ? "complete" : "incomplete";
        }, undefined, outcome);
        if (complete) assert.equal(await result, "complete", "finished geometry needs no retry or deadline rejection");
        else await assert.rejects(result, /Incomplete build: retry deadline/);
        assert.equal(outcome.complete, complete);
    }
});

test("ordinary build errors propagate and restore the sparse miss listener", async () => {
    const cache = sparseCache();
    const listener = cache.js5.store.onMiss;
    await assert.rejects(runWithSparseRetry(cache.state, async () => {
        throw new Error("invalid model data");
    }), /invalid model data/);
    assert.equal(cache.js5.store.onMiss, listener);
});


test("cancelled scene builds leave stalled JS5 waits without publishing incomplete data", async () => {
    const cache = sparseCache();
    const controller = new AbortController();
    const previousMiss = cache.js5.store.onMiss;
    let waiting!: () => void;
    const started = new Promise<void>(resolve => { waiting = resolve; });
    cache.js5.settled = () => { waiting(); return new Promise<void>(() => {}); };
    const outcome = { complete: false };
    const build = runWithSparseRetry(cache.state, async () => {
        cache.missing(1);
        return "incomplete";
    }, undefined, outcome, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(build, { name: "AbortError" });
    assert.equal(outcome.complete, false);
    assert.equal(cache.state.scenePasses, 0);
    assert.equal(cache.js5.store.onMiss, previousMiss);
});
