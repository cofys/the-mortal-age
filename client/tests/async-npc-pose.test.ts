import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AsyncNpcPoseCache } from "../render/npc/AsyncNpcPoseCache";
import { DynamicNpcAnimLoader, npcAppearanceKey } from "../render/npc/DynamicNpcAnimLoader";
import { NpcPoseJob } from "../game/worker/NpcPoseJob";
import { runWithSparseRetry } from "../game/worker/SparseRetry";
import { Model } from "../rs/model/Model";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { CustomModelRegistry } from "../custom/items/CustomModelRegistry";
import { ActorGeometryCache } from "../render/webgpu/actors/actorGpu";

(globalThis as any).self = globalThis;
const { RenderDataWorkerPool } = require("../game/worker/RenderDataWorkerPool");

const turn = () => sleep(5);
function fixture() {
    const type: any = { id: 1, modelIds: [1], widthScale: 128, heightScale: 128, ambient: 0, contrast: 0 };
    const seq = new SeqType(1, { game: "oldschool", revision: 241 } as any);
    seq.frameIds = [1, 2, 3, 4]; seq.frameLengths = [2, 2, 2, 2];
    const cache = new Map();
    const models: any = { modelCache: cache, modelLoader: {},
        clearCache: () => cache.clear(), getModel: () => { throw Error("Main-thread pose build"); } };
    const loader = new DynamicNpcAnimLoader({ load: () => type } as any, undefined, {} as any,
        { load: () => seq } as any, { load: () => ({}) } as any, undefined, {} as any, models);
    loader.setTextureIdIndexMap(new Map([[10, 1]]));
    const calls: Array<{ input: any; resolve: (result: any) => void; reject: (error: any) => void; signal: AbortSignal }> = [];
    const pool = { npcPoseGeneration: 0, npcPoseConcurrency: 1, loadNpcPose: (input: any, signal: AbortSignal) =>
        new Promise<any>((resolve, reject) => calls.push({ input, resolve, reject, signal })) };
    const queue = new AsyncNpcPoseCache(loader, pool);
    const geometry = (input: any) => ({ key: input.key, npcTypeId: input.request[0], seqId: input.request[1], frameId: input.request[2],
        opaqueVertices: new Uint8Array(12), opaqueIndices: new Int32Array([0]),
        alphaVertices: new Uint8Array(), alphaIndices: new Int32Array(), approxBytes: 16 });
    return { type, loader, pool, calls, queue, geometry };
}

test("first spawn schedules a worker base, retains it until the current pose arrives, then hits synchronously", async () => {
    const f = fixture();
    try {
        assert.equal(f.queue.getKey([1, 1, 0])?.includes("async-npc:"), true);
        await turn(); assert.equal(f.calls.length, 0, "resident GPU key checks must never queue work");
        assert.equal(f.queue.get([1, 1, 0], 7), undefined);
        await turn();
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].input.request[1], -1, "first spawn gets a usable base before animated work");
        const base = f.geometry(f.calls[0].input);
        f.calls[0].resolve(base); await turn();
        assert.equal(f.queue.get([1, 1, 0], 7), base);
        assert.equal(f.calls[1].input.request[1], 1);
        const pose = f.geometry(f.calls[1].input);
        f.calls[1].resolve(pose); await turn();
        assert.equal(f.queue.get([1, 1, 0], 7), pose);
        assert.equal(f.queue.getFallbackKey([1, 1, 3], 7), pose.key);
        const queued = f.calls.length;
        f.queue.get([1, 1, 0], 7); f.queue.get([1, 1, 0], 8);
        await turn(); assert.equal(f.calls.length, queued, "an active next-pose request is deduplicated too");
        assert.ok(f.queue.stats.firstUsableLatencyMs > 0);
    } finally { f.queue.dispose(); }
});

test("queued current poses replace an actor's older work and stay ahead of bounded prefetch", async () => {
    const f = fixture();
    try {
        f.queue.get([1, 1, 0], 7); await turn();
        f.queue.get([1, 1, 1], 7); f.queue.get([1, 1, 2], 7);
        const jobs = [...(f.queue as any).queued.values()] as any[];
        assert.ok(!jobs.some(j => j.priority === 0 && j.input.request[1] === 1 && j.input.request[2] < 2));
        f.calls[0].resolve(f.geometry(f.calls[0].input)); await turn();
        assert.equal(f.calls[1].input.request[2], 2, "latest current pose runs before speculative next poses");
        for (let id = 0; id < 100; id++) {
            f.type.id = id + 1; f.type.modelIds = [id + 1]; f.queue.get([id + 1, 1, id % 3], id + 50);
        }
        assert.ok((f.queue as any).queued.size <= 24);
    } finally { f.queue.dispose(); }
});

test("renderer reset, texture replacement, custom appearance and pool generation cannot publish stale poses", async () => {
    const f = fixture();
    try {
        f.queue.get([1, 1, 0], 1); await turn();
        const stale = f.calls[0], oldKey = stale.input.key;
        f.loader.setTextureIdIndexMap(new Map([[10, 9]]));
        const newKey = f.queue.getKey([1, 1, 0]);
        assert.notEqual(newKey, oldKey);
        assert.equal(stale.signal.aborted, true);
        stale.resolve(f.geometry(stale.input)); await turn();
        assert.equal(f.loader.getCachedGeometry(oldKey), undefined);
        f.type.modelIds = [123];
        assert.notEqual(f.queue.getKey([1, 1, 0]), newKey, "same-ID changed appearances cannot reuse old geometry");
        const appearanceKey = f.queue.getKey([1, 1, 0]);
        const textureMap = f.loader.getTextureIdIndexMap()!;
        textureMap.set(10, 12);
        f.loader.setTextureIdIndexMap(textureMap);
        assert.notEqual(f.queue.getKey([1, 1, 0]), appearanceKey, "publishing a changed layer in the same Map invalidates poses");
        const beforeAppend = f.queue.getKey([1, 1, 0]);
        textureMap.set(11, 13);
        assert.notEqual(f.queue.getKey([1, 1, 0]), beforeAppend, "stable-ID layer appends also invalidate the captured mapping");
        f.pool.npcPoseGeneration++;
        assert.notEqual(f.queue.getKey([1, 1, 0]), appearanceKey);
        f.queue.get([1, 1, 0], 1); await turn();
        const pending = f.calls[f.calls.length - 1];
        f.queue.dispose(); pending.resolve(f.geometry(pending.input)); await turn();
        assert.equal(f.loader.getCachedGeometry(pending.input.key), undefined);
        assert.equal(f.queue.get([1, 1, 0], 1), undefined);
    } finally { f.queue.dispose(); }
});

test("nested var-dependent NPC transforms identify the final body before sharing async geometry", () => {
    const f = fixture();
    try {
        const second = { ...f.type, id: 2, modelIds: [2] };
        let variant = f.type;
        const nested = { id: 10, transforms: [1, 2], transform: () => variant };
        const root = { id: 20, transforms: [10], transform: () => nested };
        (f.loader as any).npcTypeLoader = { load: (id: number) => id === 20 ? root : id === 10 ? nested : id === 2 ? second : f.type };
        const first = f.loader.getAsyncPoseRequest(20, 1, 0)!;
        assert.equal(first.request[0], 1);
        variant = second;
        const changed = f.loader.getAsyncPoseRequest(20, 1, 0)!;
        assert.equal(changed.request[0], 2);
        assert.notEqual(changed.appearance, first.appearance);
    } finally { f.queue.dispose(); }
});

test("shared NPC source contexts invalidate raw models and keys on content and same-type appearance changes", () => {
    const f = fixture(), revision = CustomModelRegistry.revision;
    const models = f.loader.getModelLoader()!.modelCache;
    try {
        const oldContext = f.loader.getContextKey();
        const oldCanonical = f.loader.getFrameGeometryKey(1, 1, 0);
        models.set(1, new Model());
        f.type.widthScale = 160;
        assert.equal(f.loader.peekBaseModel(1), undefined, "an in-place appearance change drops the stale raw model without rebuilding it");
        assert.notEqual(f.loader.getContextKey(), oldContext);
        assert.notEqual(f.loader.getFrameGeometryKey(1, 1, 0), oldCanonical, "canonical IDs never repeat for a changed same-ID appearance");
        models.set(1, new Model());
        const beforeCustom = f.loader.getContextKey();
        CustomModelRegistry.revision++;
        assert.notEqual(f.loader.getContextKey(), beforeCustom);
        assert.equal(models.size, 0);
        models.set(1, new Model());
        const beforeLoader = f.loader.getContextKey();
        (f.loader.getModelLoader()!.modelLoader as any).revision = 2;
        assert.notEqual(f.loader.getContextKey(), beforeLoader);
        assert.equal(models.size, 0);
    } finally { CustomModelRegistry.revision = revision; f.queue.dispose(); }
});

test("transient worker failures remain retryable and missing configuration never falls back to synchronous baking", async t => {
    const f = fixture();
    let now = 100;
    t.mock.method(performance, "now", () => now);
    try {
        f.queue.get([1, -1, 0], 1); await turn();
        f.calls[0].reject(Error("Worker temporarily unavailable")); await turn();
        f.queue.get([1, -1, 0], 1); await turn(); assert.equal(f.calls.length, 1);
        now += 251; f.queue.get([1, -1, 0], 1); await turn(); assert.equal(f.calls.length, 2);
        f.calls[1].resolve(f.geometry(f.calls[1].input)); await turn();
        assert.ok(f.queue.get([1, -1, 0], 1));
        (f.loader as any).getAsyncPoseRequest = () => { throw Error("Sparse config unavailable"); };
        assert.equal(f.queue.get([1, 1, 0], 1), undefined);
    } finally { f.queue.dispose(); }
});

test("worker poses preserve synchronous packing bytes, transfer ownership, defer to scenes and retry incomplete data", async () => {
    const f = fixture();
    const model = new Model();
    model.verticesCount = 3; model.verticesX = new Int32Array([0, 128, 0]);
    model.verticesY = new Int32Array([0, 0, -128]); model.verticesZ = new Int32Array(3);
    model.faceCount = 1; model.indices1 = new Int32Array([0]); model.indices2 = new Int32Array([1]); model.indices3 = new Int32Array([2]);
    model.faceColors1 = model.faceColors2 = model.faceColors3 = new Int32Array([100]);
    let incomplete = false;
    const state: any = { sceneJobs: 0, scenePasses: 0, npcTypeLoader: (f.loader as any).npcTypeLoader,
        textureLoader: {}, seqTypeLoader: (f.loader as any).seqTypeLoader,
        seqFrameLoader: (f.loader as any).seqFrameLoader, varManager: {},
        js5: { store: { missCount: 0 } }, npcModelLoader: f.loader.getModelLoader() };
    state.npcModelLoader.getModel = (type: any) => {
        if (incomplete) state.js5.store.missCount++;
        state.npcModelLoader.modelCache.set(type.id, model); return model;
    };
    const source = f.loader.getFrameGeometry(1, 1, 0)!;
    const job = new NpcPoseJob(state);
    const input = { context: "test", key: "expected-key", appearance: npcAppearanceKey(f.type),
        request: f.loader.getAsyncPoseRequest(1, 1, 0)!.request, textures: [[10, 1] as [number, number]] };
    try {
        const output = (await job.load(input))! as any;
        for (const name of ["opaqueVertices", "opaqueIndices", "alphaVertices", "alphaIndices"] as const) assert.deepEqual(output[name], source[name]);
        const transferred = structuredClone(output, { transfer: [output.opaqueVertices.buffer, output.opaqueIndices.buffer,
            output.alphaVertices.buffer, output.alphaIndices.buffer] });
        assert.equal(output.opaqueVertices.byteLength, 0);
        assert.deepEqual(((await job.load(input))! as any).opaqueVertices, transferred.opaqueVertices, "detached arrays never stay in the worker pose cache");
        state.sceneJobs = 1; state.scenePasses = 1; assert.deepEqual(await job.load(input), { busy: true });
        state.scenePasses = 0; assert.ok(await job.load(input), "foreground download waits must not starve visible NPCs");
        state.sceneJobs = 0; incomplete = true;
        assert.equal(await job.load(input), undefined, "a partial build is never transferred or cached");
        incomplete = false; assert.ok(await job.load(input));
        const interpolated = { ...input, request: f.loader.getAsyncPoseRequest(1, 1, 0, -1, -1,
            { base: { next: 1, alpha: 0.5 } })!.request };
        const frameLoad = state.seqFrameLoader.load;
        state.seqFrameLoader.load = (id: number) => id === 2 ? undefined : {};
        assert.equal(await job.load(interpolated), undefined,
            "a worker missing the next frame cannot relabel an unblended mesh as the requested interpolated pose");
        state.seqFrameLoader.load = frameLoad;
        assert.ok(await job.load(interpolated), "the original request recovers once its next frame arrives");
        model.faceCount = 0;
        assert.equal(await job.load(input), undefined, "empty animated geometry must leave the usable base fallback in place");
        model.faceCount = 1;
        assert.ok(await job.load(input), "an empty pass must not poison later usable geometry");
        job.dispose(); assert.equal(await job.load(input), undefined);
    } finally { f.queue.dispose(); }
});

test("pool bounds lost replies and cancellation prevents late dispatch after relogin", async t => {
    let workerReady!: (worker: any) => void, calls = 0;
    const worker = { setCustomContent: async () => {}, loadNpcPose: async () => { calls++; return undefined; } };
    const pool = new RenderDataWorkerPool({}, [{ init: new Promise(resolve => { workerReady = resolve; }) }], 1);
    const input: any = { context: "test", key: "test", appearance: "[]", request: [1, -1, 0], textures: [] };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const promise = pool.loadNpcPose(input);
    t.mock.timers.tick(3000);
    assert.equal(await promise, undefined);
    workerReady(worker); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 0, "a timed-out request cannot dispatch later when worker initialization completes");
    const cancel = new AbortController();
    const cancelled = pool.loadNpcPose(input, cancel.signal); cancel.abort();
    assert.equal(await cancelled, undefined);
    await Promise.resolve(); await Promise.resolve(); assert.equal(calls, 0);
});

test("foreground download waits release the pass counter and miss listener without collecting background NPC misses", async () => {
    const seen: number[] = [], checked: number[] = [];
    let release!: () => void, pass = 0;
    const original = (span: any) => seen.push(span.archiveId);
    const store = { missCount: 0, onMiss: original,
        isGroupPresent: (_index: number, id: number) => { checked.push(id); return true; } };
    const state = { sceneJobs: 1, scenePasses: 0, js5: { store,
        settled: () => new Promise<void>(resolve => { release = resolve; }) } } as any;
    const outcome = { complete: false };
    const build = runWithSparseRetry(state, async () => {
        assert.equal(state.scenePasses, 1);
        if (pass++ === 0) { store.missCount++; store.onMiss({ indexId: 1, archiveId: 10 }); }
        return "complete";
    }, undefined, outcome);
    await turn();
    assert.equal(state.sceneJobs, 1);
    assert.equal(state.scenePasses, 0);
    assert.equal(store.onMiss, original);
    // This is a background NPC read while a foreground group is downloading.
    store.missCount++; store.onMiss({ indexId: 1, archiveId: 99 });
    release();
    assert.equal(await build, "complete");
    assert.equal(outcome.complete, true);
    assert.deepEqual(checked, [10], "background dependencies must never enter the foreground retry collector");
    assert.deepEqual(seen, [10, 99]);
    assert.equal(store.onMiss, original);
    assert.equal(state.scenePasses, 0);
    await assert.rejects(runWithSparseRetry(state, async () => { throw Error("Build failed"); }), /Build failed/);
    assert.equal(store.onMiss, original);
    assert.equal(state.scenePasses, 0);
    const resident = { scenePasses: 0 };
    await assert.rejects(runWithSparseRetry(resident, async () => { throw Error("Resident build failed"); }), /Resident build failed/);
    assert.equal(resident.scenePasses, 0, "non-sparse passes restore their priority counter too");
});

test("actor fallback ownership never substitutes a different actor's action pose", async () => {
    const f = fixture();
    try {
        f.queue.get([1, 1, 0], 7); await turn();
        f.calls[0].resolve(f.geometry(f.calls[0].input)); await turn();
        f.calls[1].resolve(f.geometry(f.calls[1].input)); await turn();
        const actor7 = f.queue.get([1, 1, 0], 7)!;
        assert.notEqual(f.queue.get([1, 2, 0], 8)?.key, actor7.key, "actor8 cannot borrow actor7's ongoing action");
        assert.notEqual(f.queue.getFallbackKey([1, 2, 0], 8), actor7.key);
        assert.equal(f.queue.getFallbackKey([1, 1, 3], 7), actor7.key);
        f.queue.get([1, 2, 2], 7);
        assert.notEqual(f.queue.getFallbackKey([1, 2, 2], 7), actor7.key, "an obsolete action cannot become the new animation's fallback");
    } finally { f.queue.dispose(); }
});

test("slow worker service gives every actor a base before repeatedly advancing earlier actors", async t => {
    const f = fixture();
    let now = 100;
    t.mock.method(performance, "now", () => now);
    const usable = new Set<number>();
    try {
        for (let step = 0; step < 9; step++) {
            for (let id = 1; id <= 3; id++) {
                f.type.id = id; f.type.modelIds = [id];
                const displayed = f.queue.get([id, 1, step % 3], id);
                if (displayed) usable.add(id);
            }
            await turn();
            const call = f.calls[step];
            assert.ok(call, `worker must keep making progress at step ${step}`);
            call.resolve(f.geometry(call.input));
            now += 40; // Two frames of latency while the camera keeps rendering new requests.
            await turn();
            if (step === 3) assert.equal(usable.size, 3, "all three first spawns get base geometry within three worker turns");
        }
        assert.equal(usable.size, 3);
        assert.ok(f.queue.stats.maxPoseAgeMs <= 360, "finite service keeps displayed pose age bounded in this slow-worker workload");
    } finally { f.queue.dispose(); }
});

test("despawned ECS indices cannot inherit previous poses or late animated callbacks", async () => {
    const f = fixture();
    try {
        f.queue.get([1, 1, 0], 7); await turn();
        f.calls[0].resolve(f.geometry(f.calls[0].input)); await turn();
        const oldAnimated = f.calls[1], oldKey = oldAnimated.input.key;
        f.queue.forgetActor(7);
        const base = f.queue.get([1, 1, 3], 7);
        assert.equal(base?.seqId, -1, "a new actor may reuse canonical base geometry, never the old actor's action state");
        oldAnimated.resolve(f.geometry(oldAnimated.input)); await turn();
        assert.notEqual(f.queue.getFallbackKey([1, 1, 3], 7), oldKey);
    } finally { f.queue.dispose(); }
});

test("exact resident GPU poses become owned fallbacks and delayed replies cannot replace a newer displayed pose", async t => {
    const f = fixture(), resident = new Set<string>();
    const queue = new AsyncNpcPoseCache(f.loader, f.pool, key => resident.has(key));
    let now = 100;
    t.mock.method(performance, "now", () => now);
    try {
        const first = queue.getKey([1, 1, 0], 7)!;
        resident.add(first);
        queue.getKey([1, 1, 0], 7);
        now += 10;
        assert.equal(queue.get([1, 1, 1], 7), undefined, "the CPU cache can be empty while a usable GPU pose remains resident");
        assert.equal(queue.getFallbackKey([1, 1, 1], 7), first);
        await turn();
        assert.equal(f.calls[0].input.request[1], 1, "a resident GPU fallback must not trigger an unnecessary base build");
        assert.equal(f.calls[0].input.request[2], 1);
        now += 10;
        const latest = queue.getKey([1, 1, 3], 7)!;
        resident.add(latest);
        queue.getKey([1, 1, 3], 7);
        f.calls[0].resolve(f.geometry(f.calls[0].input)); await turn();
        assert.equal(queue.getFallbackKey([1, 1, 2], 7), latest,
            "a late frame1 completion cannot overwrite the more recently displayed resident frame3");
        const base = queue.getKey([1, -1, 0], 7)!;
        resident.add(base);
        queue.getKey([1, -1, 0], 7);
        resident.delete(latest);
        assert.equal(queue.getFallbackKey([1, 1, 2], 7), base,
            "an evicted previous pose must fall through to a still-resident base instead of making the NPC disappear");
    } finally { queue.dispose(); f.queue.dispose(); }
});

test("missing animation config still schedules and displays an available base without synchronous baking", async () => {
    const f = fixture();
    try {
        (f.loader as any).seqTypeLoader.load = () => { throw Error("Sequence config still downloading"); };
        assert.equal(f.queue.get([1, 1, 0], 7), undefined);
        await turn();
        assert.equal(f.calls[0].input.request[1], -1);
        const base = f.geometry(f.calls[0].input);
        f.calls[0].resolve(base); await turn();
        assert.equal(f.queue.get([1, 1, 0], 7), base);
    } finally { f.queue.dispose(); }
});

test("active NPC base geometry and empty-pass metadata survive animated-pose LRU churn", async () => {
    const f = fixture();
    const gpu = new ActorGeometryCache({ createBuffer: () => ({ destroy() {} }), queue: { writeBuffer() {} } } as any, 3);
    const resident = (key: string) => gpu.get(key + "|o") !== undefined && gpu.get(key + "|a") !== undefined;
    const queue = new AsyncNpcPoseCache(f.loader, f.pool, resident);
    const upload = (key: string) => {
        gpu.getOrCreate(key + "|o", new Uint8Array(12), new Int32Array([0]));
        gpu.getOrCreate(key + "|a", new Uint8Array(), new Int32Array());
    };
    try {
        const base = queue.getKey([1, -1, 0], 7)!;
        upload(base);
        for (let frame = 0; frame < 8; frame++) {
            const key = queue.getKey([1, 1, frame % 4], 7)!;
            upload(key);
            queue.getKey([1, 1, frame % 4], 7);
        }
        queue.getKey([1, 2, 0], 7);
        const fallback = queue.getFallbackKey([1, 2, 0], 7)!;
        assert.equal(fallback, base);
        assert.equal(resident(fallback), true, "a movement/action change must retain a drawable neutral base");
        queue.get([1, 2, 0], 7); await turn();
        assert.equal(f.calls[0].input.request[1], 2, "a resident base must not require another base worker build");
        queue.forgetActor(7);
        for (let i = 0; i < 4; i++) upload(`unrelated-${i}`);
        assert.equal(resident(base), false, "inactive actors do not pin entries outside the existing cache budget");
    } finally { queue.dispose(); f.queue.dispose(); gpu.destroy(); }
});

test("two existing worker slots serve two poses concurrently and older replies cannot rewind published fallbacks", async t => {
    const f = fixture();
    f.pool.npcPoseConcurrency = 2;
    t.mock.method(performance, "now", () => 100); // Reduced precision must not make reply ordering ambiguous.
    const request = (frame: number): [number, number, number, number, number, any] =>
        [1, 1, frame, -1, -1, { base: { next: (frame + 1) % 4, alpha: 0.5 } }];
    try {
        f.queue.get(request(0), 7); await turn();
        assert.equal(f.calls.length, 2, "base and current pose use the two available slots");
        f.calls[0].resolve(f.geometry(f.calls[0].input));
        f.calls[1].resolve(f.geometry(f.calls[1].input)); await turn();
        f.queue.get(request(1), 7); await turn();
        const first = f.calls.find(call => call.input.request[1] === 1 && call.input.request[2] === 1)!;
        assert.ok(first);
        f.queue.get(request(2), 7); await turn();
        const newer = f.calls.find(call => call.input.request[1] === 1 && call.input.request[2] === 2)!;
        assert.ok(newer, "a second pose starts while the older one remains in flight");
        f.queue.get(request(3), 7); // Both replies are fallbacks to a now-newer requested frame.
        newer.resolve(f.geometry(newer.input)); await turn();
        const published = f.queue.getFallbackKey(request(3), 7);
        first.resolve(f.geometry(first.input)); await turn();
        assert.equal(f.queue.getFallbackKey(request(3), 7), published,
            "an older completion cannot replace the newer worker-published fallback even before an exact render hit");
        assert.ok(f.loader.getCachedGeometry(first.input.key), "out-of-order data remains reusable in the canonical cache");
        assert.ok((f.queue as any).active.size <= 2);
        f.queue.dispose();
        assert.ok(f.calls.every(call => call.signal.aborted || f.loader.getCachedGeometry(call.input.key)));
    } finally { f.queue.dispose(); }
});

test("parallel cancellation aborts both requests and stale replies cannot remove or publish a reused key", async () => {
    const f = fixture(); f.pool.npcPoseConcurrency = 2;
    try {
        f.queue.get([1, 1, 0], 7); await turn();
        const old = f.calls.slice();
        f.loader.clear(); f.queue.get([1, 1, 0], 7); await turn();
        assert.ok(old.every(call => call.signal.aborted));
        assert.equal((f.queue as any).active.size, 2);
        for (const call of old) call.resolve(f.geometry(call.input)); await turn();
        assert.equal((f.queue as any).active.size, 2, "old finally handlers must not release new-generation slots");
        assert.ok(old.every(call => !f.loader.getCachedGeometry(call.input.key)));
        f.queue.dispose();
        for (const call of f.calls.slice(2)) call.resolve(f.geometry(call.input)); await turn();
        assert.equal((f.queue as any).active.size, 0);
    } finally { f.queue.dispose(); }
});

test("pool reserves distinct existing descriptors, retains in-flight occupancy after cancellation and reuses it after completion", async () => {
    const pending: Array<{ worker: number; resolve: (value: any) => void }> = [];
    let wakes = 0;
    const descriptors = Array.from({ length: 4 }, (_, worker) => ({ runningTasks: [] as Promise<any>[],
        init: Promise.resolve({ setCustomContent: async () => {}, loadNpcPose: () =>
            new Promise(resolve => pending.push({ worker, resolve })) }) }));
    const pool = new RenderDataWorkerPool({ scheduleWork: () => wakes++ }, descriptors, 4);
    const input: any = { context: "test", key: "test", appearance: "[]", request: [1, -1, 0], textures: [] };
    const abort = new AbortController();
    const a = pool.loadNpcPose(input, abort.signal), b = pool.loadNpcPose(input);
    await turn();
    assert.equal(pool.npcPoseConcurrency, 2);
    assert.deepEqual(pending.map(job => job.worker), [0, 1]);
    assert.equal(descriptors[2].runningTasks.length + descriptors[3].runningTasks.length, 0, "other workers remain available for foreground maps");
    assert.deepEqual(await pool.loadNpcPose(input), { busy: true });
    const foreground = Promise.resolve();
    descriptors[0].runningTasks = [...descriptors[0].runningTasks, foreground];
    abort.abort(); assert.equal(await a, undefined);
    assert.equal(descriptors[0].runningTasks.length, 2, "caller cancellation does not free a still-running RPC or foreground task");
    pending[0].resolve(undefined); await turn();
    assert.deepEqual(descriptors[0].runningTasks, [foreground], "completion removes only its own marker from the current tasks array");
    descriptors[0].runningTasks = [];
    const c = pool.loadNpcPose(input); await turn();
    assert.equal(pending[2].worker, 0);
    pending[1].resolve(undefined); pending[2].resolve(undefined); await Promise.all([b, c]);
    assert.ok(descriptors.every(worker => worker.runningTasks.length === 0));
    assert.ok(wakes > 0, "releasing a reservation wakes normal queued pool work");
    const single = new RenderDataWorkerPool({}, [descriptors[0]], 1);
    assert.equal(single.npcPoseConcurrency, 1);
    const only = single.loadNpcPose(input); await turn();
    assert.deepEqual(await single.loadNpcPose(input), { busy: true });
    pending[3].resolve(undefined); await only;
    let initialized!: (worker: any) => void, shutdownWakes = 0;
    const shutdown = new RenderDataWorkerPool({ scheduleWork: () => shutdownWakes++, terminate: async () => {} },
        [{ init: new Promise(resolve => { initialized = resolve; }), runningTasks: [] }], 1);
    const unstarted = shutdown.loadNpcPose(input);
    await shutdown.terminate();
    assert.equal(await unstarted, undefined);
    assert.equal(shutdownWakes, 0, "terminating an undispatched reservation must not start queued foreground work");
    initialized({ setCustomContent: async () => {} });
});
