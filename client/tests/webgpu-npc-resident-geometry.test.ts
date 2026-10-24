import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { mat4 } from "gl-matrix";
import { Frustum } from "../game/Frustum";

import { DynamicNpcAnimLoader } from "../render/npc/DynamicNpcAnimLoader";
import { ActorGeometryCache, POSE_ROWS, POSE_WIDTH } from "../render/webgpu/actors/actorGpu";
import { ActorDataWriter, resolveUnbatchedNpcGeometry } from "../render/webgpu/actors/actorPacking";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { Model } from "../rs/model/Model";

require.extensions[".glsl"] = (module, file) => { module.exports = fs.readFileSync(file, "utf8"); };
for (const ext of [".png", ".jpg", ".webp"]) require.extensions[ext] = (module, file) => { module.exports = file; };
(globalThis as any).self = globalThis;
const { WebGPUActors } = require("../render/webgpu/actors/WebGPUActors");

function fixture(alpha = true, capacity = 8) {
    const model = new Model();
    model.verticesCount = 4;
    model.verticesX = new Int32Array([0, 128, 0, 128]);
    model.verticesY = new Int32Array([0, 0, -128, -128]);
    model.verticesZ = new Int32Array(4);
    model.faceCount = 2;
    model.indices1 = new Int32Array([0, 0]);
    model.indices2 = new Int32Array([1, 2]);
    model.indices3 = new Int32Array([2, 3]);
    model.faceColors1 = model.faceColors2 = model.faceColors3 = new Int32Array([100, 200]);
    if (alpha) model.faceAlphas = new Int8Array([0, -128]);
    let variant = 1, typeId = 1, sequence = 1, frame = 0, builds = 0, uploads = 0;
    const types = new Map<number, any>();
    for (let id = 1; id <= 3; id++) types.set(id, {
        id, modelIds: [id === 3 ? 1 : id], widthScale: 128, heightScale: 128, ambient: 0, contrast: 0,
        getMovementSeqSet: () => ({ idle: -1, walk: -1 }),
    });
    types.set(10, { transforms: [1, 2], transform: () => types.get(variant),
        getMovementSeqSet: () => ({ idle: -1, walk: -1 }) });
    const seq = new SeqType(1, { game: "oldschool", revision: 241 } as any);
    seq.frameIds = [1, 2]; seq.frameLengths = [2, 2];
    const ready = new Set([1, 2]);
    const typeLoader = { load: (id: number) => types.get(id) };
    const loader = new DynamicNpcAnimLoader(typeLoader as any, undefined, {} as any,
        { load: () => seq } as any, { load: (id: number) => ready.has(id) ? {} : undefined } as any,
        undefined, {} as any);
    const modelCache = new Map();
    (loader as any).npcModelLoader = {
        modelCache, getModel: (type: any) => { modelCache.set(type.id, model); return model; },
    };
    loader.setTextureIdIndexMap(new Map());
    const original = (loader as any).cacheModelGeometry;
    (loader as any).cacheModelGeometry = function (...args: any[]) { builds++; return original.apply(this, args); };
    const device: any = { createBuffer: () => ({ destroy() {} }), queue: { writeBuffer: () => uploads++ } };
    const cache = new ActorGeometryCache(device, capacity);
    const client: any = {
        clientPlugins: { smoothsNpcs: () => false }, npcTypeLoader: typeLoader,
        npcEcs: {
            getNpcTypeId: () => typeId, getSeqId: () => sequence, getSeqDelay: () => 0,
            getFrameIndex: () => frame, getMovementFrameIndex: () => 0,
            getMovementOverrides: () => ({}), getPathLengthLike: () => 0,
            getRotation: () => 0, getTargetRot: () => 0,
            getWorldX: () => 64, getWorldY: () => 64, getLevel: () => 0, getWorldViewId: () => -1,
            getServerId: () => 23, getColorOverride: () => ({ amount: 0 }),
        },
    };
    const actors: any = Object.create(WebGPUActors.prototype);
    Object.assign(actors, { stats: { npcCandidates: 0, npcBoundsTests: 0, npcsCulled: 0 }, npcBounds: new Map(), renderer: { osrsClient: client }, dynamicNpcLoader: loader,
        geometry: cache,
        asyncNpcPoses: { getKey: (request: any) => loader.getFrameGeometryKey(...request),
            get: (request: any) => resolveUnbatchedNpcGeometry(client, loader, 5, request), getFallbackKey: () => undefined },
        writer: new ActorDataWriter(), pipelines: new Map([["npc", [{}, {}]]]),
        actorEntry: () => 0 });
    const map = { getRenderBaseTileX: () => 0, getRenderBaseTileY: () => 0,
        getLocalTileSpan: () => 64, timeLoaded: -1 };
    const pack = () => {
        const state = { opaque: [], alpha: [], npcByEcsId: new Map() };
        actors.packNpc(state, map, 5, 10);
        return state as any;
    };
    const evictCpu = () => { (loader as any).geomCache.clear(); (loader as any).geomCacheBytes = 0; };
    return { actors, client, loader, cache, map, pack, evictCpu, ready, model,
        setType: (id: number) => { typeId = id; }, setVariant: (id: number) => { variant = id; },
        setSequence: (id: number) => { sequence = id; }, setFrame: (id: number) => { frame = id; },
        builds: () => builds, uploads: () => uploads };
}

for (const alpha of [false, true]) test(`resident NPC passes skip CPU rebuilding (alpha=${alpha})`, () => {
    const f = fixture(alpha);
    const first = f.pack();
    assert.equal(f.builds(), 1);
    const writes = f.uploads();
    f.evictCpu();
    const next = f.pack();
    assert.equal(f.builds(), 1, "a CPU eviction must not rebuild an already complete GPU pose");
    assert.equal(f.uploads(), writes, "resident geometry does not upload again");
    assert.equal(next.opaque[0].geometry, first.opaque[0].geometry);
    assert.equal(next.alpha.length, alpha ? 1 : 0, "a known-empty alpha pass stays empty");
    if (alpha) {
        assert.equal(next.alpha[0].geometry, first.alpha[0].geometry);
        assert.equal(next.alpha[0].entry, next.opaque[0].entry);
    }
});

test("partial GPU eviction rebuilds the missing NPC pass", () => {
    const f = fixture(true, 2);
    const first = f.pack();
    f.cache.getOrCreate("other", new Uint8Array(20), new Int32Array([0]));
    f.evictCpu();
    const next = f.pack();
    assert.equal(f.builds(), 2);
    assert.notEqual(next.opaque[0].geometry, first.opaque[0].geometry);
    assert.equal(next.alpha[0].geometry, first.alpha[0].geometry, "the surviving pass remains reusable");
});

test("NPC resident keys preserve normalization, appearance sharing and live transforms", () => {
    const f = fixture();
    const key = f.loader.getFrameGeometryKey(1, 1, 0)!;
    assert.equal(f.loader.getFrameGeometryKey(1, 1, 2), key);
    assert.equal(f.loader.getFrameGeometryKey(3, 1, 0), key, "identical appearances still share poses");
    assert.notEqual(f.loader.getFrameGeometryKey(2, 1, 0), key);
    assert.equal(f.loader.getFrameGeometryKey(1, 1, -2, 1, -3), f.loader.getFrameGeometry(1, 1, 0, 1, 0)!.key);
    f.setType(10); f.pack(); f.evictCpu(); f.setVariant(2);
    f.pack();
    assert.equal(f.builds(), 3, "a transformed NPC cannot reuse the old appearance's resident mesh");
});

test("missing next frames use the exact CPU fallback key and recover when ready", () => {
    const f = fixture();
    f.ready.delete(2);
    const blend = { base: { next: 1, alpha: 0.5 } };
    const key = f.loader.getFrameGeometryKey(1, 1, 0, -1, -1, blend);
    assert.equal(key, f.loader.getFrameGeometry(1, 1, 0, -1, -1, blend)!.key);
    f.ready.add(2);
    const loaded = f.loader.getFrameGeometryKey(1, 1, 0, -1, -1, blend);
    assert.notEqual(loaded, key, "late frame data must select a fresh pose");
    assert.equal(loaded, f.loader.getFrameGeometry(1, 1, 0, -1, -1, blend)!.key);
});

test("unanimated and missing-current NPC frames retain base-geometry fallback", () => {
    const f = fixture();
    let samples = 0;
    f.client.clientPlugins.smoothsNpcs = () => { samples++; return false; };
    f.setSequence(-1);
    assert.equal(f.pack().opaque.length, 1);
    assert.equal(samples, 0, "unanimated NPCs do not sample interpolation");
    f.setSequence(1); f.ready.clear(); f.evictCpu();
    assert.equal(f.pack().opaque.length, 1);
});

test("empty-pass metadata is bounded, touched on lookup, and cleared with GPU resources", () => {
    const f = fixture(false, 2), empty = new Uint8Array(), indices = new Int32Array();
    f.cache.getOrCreate("a", empty, indices); f.cache.getOrCreate("b", empty, indices);
    assert.equal(f.cache.get("a"), null);
    f.cache.getOrCreate("c", empty, indices);
    assert.equal(f.cache.get("b"), undefined);
    assert.equal(f.cache.get("a"), null);
    f.cache.getOrCreate("a", new Uint8Array(20), new Int32Array([0]));
    assert.ok(f.cache.get("a"), "a nonempty replacement supersedes an empty entry");
    f.cache.destroy();
    assert.equal(f.cache.get("a"), undefined); assert.equal(f.cache.get("c"), undefined);
});

test("NPC GPU labels share pose rows across both passes and preserve CPU fallback when rows fill", () => {
    const f = fixture();
    const source = f.loader.getFrameGeometry(1, 1, 0)!;
    const posed = { ...source, key: "npc-rest:1", poseKey: "npc-pose:1", matrices: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
        opaqueLabels: new Uint32Array(source.opaqueIndices.length), alphaLabels: new Uint32Array(source.alphaIndices.length) };
    Object.assign(f.actors, { npcPose: { resolve: () => posed }, actorData: { hasPose: () => false },
        poseRows: new Map(), poseUpload: new Float32Array(POSE_ROWS * POSE_WIDTH * 4), poseTexels: 0 });
    const rows: number[] = [];
    f.actors.actorEntry = (...args: any[]) => { rows.push(args[8]); return 0; };
    const first = f.pack();
    assert.equal(f.builds(), 1, "a GPU label pose does not build another CPU mesh");
    assert.ok(first.opaque[0].geometry.labels && first.alpha[0].geometry.labels);
    assert.deepEqual(rows, [0], "opaque and alpha geometry share the same pose/actor row");
    for (let row = 0; row < POSE_ROWS; row++) f.actors.poseRows.set(`full:${row}`, { row, matrices: posed.matrices });
    f.actors.poseRows.delete(posed.poseKey);
    const fallback = f.pack();
    assert.equal(rows.at(-1), -1, "a full pose texture draws the CPU pose without applying it a second time");
    assert.equal(fallback.opaque[0].geometry.labels, undefined);
});

test("alpha-only GPU NPC rest meshes keep their pose row and do not trigger CPU fallback", () => {
    const f = fixture();
    const source = f.loader.getFrameGeometry(1, 1, 0)!;
    Object.assign(f.actors, { npcPose: { resolve: () => ({ ...source, key: "npc-alpha", poseKey: "npc-alpha-pose",
        opaqueVertices: new Uint8Array(), opaqueIndices: new Int32Array(),
        matrices: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]), alphaLabels: new Uint32Array(source.alphaIndices.length) }) },
        actorData: { hasPose: () => false }, poseRows: new Map(),
        poseUpload: new Float32Array(POSE_ROWS * POSE_WIDTH * 4), poseTexels: 0 });
    const packed = f.pack();
    assert.equal(packed.opaque.length, 0);
    assert.equal(packed.alpha.length, 1);
    assert.ok(packed.alpha[0].geometry.labels);
    assert.equal(f.builds(), 1);
});

test("missing sequence configuration still requests the ready NPC base mesh", () => {
    const f = fixture();
    f.client.npcTypeLoader.load(1).getMovementSeqSet = () => { throw new Error("Sequence configuration still downloading"); };
    assert.equal(f.pack().opaque.length, 1, "sparse animation metadata must not hide an otherwise ready NPC");
});

test("NPC pose identity does not validate or build a CPU mesh", () => {
    const f = fixture();
    (f.loader.getModelLoader() as any).getModel = () => { throw new Error("CPU mesh work on the render thread"); };
    assert.ok(f.loader.getFrameGeometryKey(1, 1, 0));
});

test("GPU NPC sources share the existing unscaled rest model and normalized pose identity", () => {
    const f = fixture();
    const source = f.loader.getGpuPoseSource(1, 1, 2)!;
    assert.equal(source.baseModel, f.model);
    assert.ok(source.baseKey.endsWith(":1:base"));
    assert.equal(source.frameId, 0);
    assert.equal(source.key, `${f.loader.getContextKey()}:${f.loader.getFrameGeometryKey(1, 1, 0)}`);
    (f.loader.getModelLoader() as any).getModel = () => { throw Error("cached scaled rest poses must not clone again"); };
    assert.equal(f.loader.getGpuPoseSource(1, 1, 0)!.baseModel, f.model);
    f.ready.clear();
    assert.equal(f.loader.getGpuPoseSource(1, 1, 0), undefined, "streamed current frames must be ready");
});


test("exact cached NPC bounds skip CPU pose requests outside camera and shadow, preserving actor bindings", () => {
    const f = fixture();
    const camera = new Frustum();
    camera.setPlanes(mat4.ortho(mat4.create(), 20, 30, -5, 5, -5, 5));
    f.client.camera = { frustum: camera };
    Object.assign(f.map, { heightMapData: new Int16Array(4 * 66 * 66), heightMapSize: 66,
        borderSize: 0, getRenderBaseWorldX: () => 0, getRenderBaseWorldY: () => 0 });
    f.actors.shadow = null;
    let requests = 0;
    const original = f.actors.asyncNpcPoses.get;
    f.actors.asyncNpcPoses.get = (...args: any[]) => { requests++; return original(...args); };
    assert.equal(f.pack().opaque.length, 1, "unknown new poses prepare once");
    f.evictCpu();
    const hidden = f.pack();
    assert.equal(hidden.opaque.length, 0);
    assert.equal(requests, 1, "known off-screen poses must not enqueue CPU work after eviction");
    assert.equal(hidden.npcByEcsId.size, 1, "attached GFX still resolve the actor-data slot");
    assert.equal(f.actors.stats.npcsCulled, 1);
    f.actors.shadow = new Frustum();
    assert.equal(f.pack().opaque.length, 1, "an off-screen shadow caster remains drawn");
    f.actors.shadow = null;
    camera.setPlanes(mat4.ortho(mat4.create(), -5, 5, -5, 5, -5, 5));
    assert.equal(f.pack().opaque.length, 1, "turning the camera reveals the resident actor immediately");
    camera.setPlanes(mat4.ortho(mat4.create(), 20, 30, -5, 5, -5, 5));
    f.client.npcEcs.getWorldViewId = () => 1;
    assert.equal(f.pack().opaque.length, 1, "deck-local actor coordinates must not be camera-culled");
    f.client.npcEcs.getWorldViewId = () => -1;
    f.setType(2);
    assert.equal(f.pack().opaque.length, 1, "a new appearance cannot inherit another pose's bound");
});


test("actor updates keep simulation ahead of packing and preserve an unknown shadow volume", () => {
    const actors = new WebGPUActors({ osrsClient: { clientPlugins: { gpuSettings: () => undefined,
        hdEnabled: () => false }, renderDistance: 40 }, stats: { frameCount: 1 },
        mapManager: { visibleMaps: [] }, playerPosUni: [0, 0] });
    actors.world = {};
    const order: string[] = [];
    actors.gfx = { projectiles: { update: () => order.push("projectiles") }, manager: {
        update: () => order.push("gfx"), resetWorldBindings: () => order.push("bindings") } };
    actors.stepNpcClientAnimations = () => order.push("animations");
    actors.tileSelection.ensureForFrame = () => order.push("tiles");
    actors.update(1, undefined);
    assert.equal(actors.shadow, undefined, "an unavailable extension frustum must not become camera-only culling");
    assert.deepEqual(order, ["projectiles", "gfx", "animations", "tiles", "bindings"]);
    actors.update(2, null);
    assert.equal(actors.shadow, null, "a renderer without shadows may use camera-only culling");
});

test("HD prepares the current actor shadow frustum once and preserves cached world shadow refreshes", () => {
    const { createHdWebGPUExtension } = require("../game/plugins/hd/webgpu/HdWebGPU");
    const device = { createTexture: () => ({ createView: () => ({}) }), createBuffer: () => ({}),
        createSampler: () => ({}), queue: { writeTexture() {} } };
    const extension = createHdWebGPUExtension(() => true, () => ({}), { device, textureIdIndexMap: new Map() });
    let updates = 0, worlds = 0, actors = 0, copies = 0;
    extension.update = () => {
        updates++;
        extension.shadowFrustum.setPlanes(mat4.ortho(mat4.create(), updates * 10, updates * 10 + 5, -5, 5, -5, 5));
        return updates !== 2;
    };
    const renderer = { drawWorldDepth: (_pass: unknown, shadow: Frustum) => {
        worlds++; assert.equal(shadow, extension.shadowFrustum);
    }, drawActorDepth: () => actors++ };
    const encoder = { beginRenderPass: () => ({ end() {} }), copyTextureToTexture: () => copies++ };
    const current = extension.prepareActorVisibility(renderer);
    assert.equal(current, extension.shadowFrustum);
    assert.equal(current.intersectsBox([[11, 0, 0], [12, 1, 1]]), true);
    extension.beforeScene(renderer, encoder);
    assert.equal(updates, 1, "drawing must reuse the visibility preparation's matrix");
    extension.prepareActorVisibility(renderer);
    extension.beforeScene(renderer, encoder);
    assert.equal(updates, 2);
    assert.equal(worlds, 1, "the cached world shadow does not refresh on steady frames");
    assert.equal(actors, 2); assert.equal(copies, 2);
    extension.beforeScene(renderer, encoder);
    assert.equal(updates, 3, "direct extension callers still prepare their own frame");
    assert.equal(worlds, 2); assert.equal(actors, 3);
});
