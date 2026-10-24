import assert from "node:assert/strict";

import { NpcPoseGeometry } from "../render/webgpu/actors/actorNpcs";
import { DynamicNpcAnimLoader } from "../render/npc/DynamicNpcAnimLoader";
import { SceneBuffer, getModelFacesFiltered } from "../render/buffer/SceneBuffer";
import { buildActorNormals } from "../render/buffer/ActorNormals";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";
import { Model } from "../rs/model/Model";
import { SeqBase } from "../rs/model/seq/SeqBase";
import { SeqFrame } from "../rs/model/seq/SeqFrame";
import { SeqTransformType } from "../rs/model/seq/SeqTransformType";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { CustomModelRegistry } from "../custom/items/CustomModelRegistry";

const info = loadCacheList(loadCacheInfos()).latest;
const factory = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, loadCache(info).files));
const textureLoader = factory.getTextureLoader(), types = factory.getNpcTypeLoader();
const seqs = factory.getSeqTypeLoader(), frames = factory.getSeqFrameLoader();
const textureIds = new Map(textureLoader.getTextureIds().filter(id => textureLoader.isSd(id)).slice(0, 1023).map((id, index) => [id, index + 1]));
const loader = new DynamicNpcAnimLoader(types, factory.getModelLoader(), textureLoader, seqs, frames, factory.getSkeletalSeqLoader(), {} as any);
loader.setTextureIdIndexMap(textureIds);
const client: any = { textureLoader, seqTypeLoader: seqs, seqFrameLoader: frames };
const poses = new NpcPoseGeometry(client, loader, textureIds);
let checked = 0, largestPositionError = 0, hdEligible = 0;
const gpuReadbackCases: unknown[] = [];

function comparePose(id: number, sequence: number, frame: number, alpha: number, overlay = -1, overlayFrame = -1) {
    const seq = seqs.load(sequence);
    const next = (frame + 1) % seq.frameIds.length;
    const interpolation = { base: { next, alpha }, overlay: overlay < 0 ? undefined : { next: (overlayFrame + 1) % seqs.load(overlay).frameIds.length, alpha: 0.25 } };
    const request: Parameters<DynamicNpcAnimLoader["getFrameGeometry"]> = [id, sequence, frame, overlay, overlayFrame, interpolation];
    const gpu = poses.resolve(request, false);
    if (!gpu) return false; // Unsupported alpha/colour/skeletal frames retain the CPU path.
    const type = types.load(id);
    const cpu = loader.getModelLoader()!.getModel(type, sequence, frame, overlay, overlayFrame, interpolation)!;
    for (const transparent of [false, true]) {
        const vertices = transparent ? gpu.alphaVertices : gpu.opaqueVertices;
        const labels = transparent ? gpu.alphaLabels! : gpu.opaqueLabels!;
        const faces = getModelFacesFiltered(cpu, textureLoader, transparent);
        if (process.env.NPC_GPU_CAPTURE && !transparent && alpha === 0.5 && frame === 0 && [13, 3106].includes(id) && overlay < 0) {
            const expected = new Float32Array(faces.length * 9);
            for (let face = 0; face < faces.length; face++) {
                const index = faces[face].index;
                [cpu.indices1[index], cpu.indices2[index], cpu.indices3[index]].forEach((v, corner) => {
                    expected.set([cpu.verticesX[v], cpu.verticesY[v], cpu.verticesZ[v]], face * 9 + corner * 3);
                });
            }
            const encode = (data: ArrayBufferView) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
            gpuReadbackCases.push({ id, sequence, vertices: encode(vertices), labels: encode(labels), matrices: encode(gpu.matrices!), expected: encode(expected) });
        }
        assert.equal(vertices.byteLength, faces.length * 3 * 20);
        const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4);
        const reference = new SceneBuffer(textureLoader, textureIds, faces.length * 3, true);
        reference.addModel(cpu, faces, undefined, false, buildActorNormals(cpu));
        const packed = new Uint32Array(reference.vertexBuf.byteArray().buffer, 0, faces.length * 3 * 5);
        for (let face = 0; face < faces.length; face++) {
            const index = faces[face].index;
            const corners = [cpu.indices1[index], cpu.indices2[index], cpu.indices3[index]];
            for (let corner = 0; corner < 3; corner++) {
                const vertex = face * 3 + corner, word = vertex * 5, fraction = words[word + 4];
                const rest = [((words[word] >>> 17) & 32767) - 16384 + (fraction & 1023) / 1024,
                    -((words[word + 1] & 32767) - 16384) - ((fraction >>> 10) & 1023) / 1024,
                    ((words[word + 2] >>> 17) & 32767) - 16384 + ((fraction >>> 20) & 1023) / 1024];
                let position = rest;
                if (labels[vertex]) {
                    const matrix = (labels[vertex] - 1) * 12, m = gpu.matrices!;
                    position = [0, 1, 2].map(row => m[matrix + row * 4] * rest[0] + m[matrix + row * 4 + 1] * rest[1] + m[matrix + row * 4 + 2] * rest[2] + m[matrix + row * 4 + 3]);
                }
                const source = corners[corner];
                const expected = [cpu.verticesX[source], cpu.verticesY[source], cpu.verticesZ[source]];
                for (let axis = 0; axis < 3; axis++) {
                    const error = Math.abs(position[axis] - expected[axis]);
                    largestPositionError = Math.max(largestPositionError, error);
                    assert.ok(error < 1 / 1024, `NPC${id} seq${sequence} frame${frame} axis${axis}: ${error}`);
                }
                // Recolour/retexture, UVs, alpha, priorities and shaded/base HSL stay unchanged.
                for (const [offset, mask] of [[0, 0x1ffff], [1, 0xffff8000], [2, 0x1ffff], [3, 0xffff]]) {
                    assert.equal(words[word + offset] & mask, packed[word + offset] & mask);
                }
            }
        }
    }
    const again = poses.resolve(request, false)!;
    assert.equal(again.matrices, gpu.matrices, "unchanged poses retain immutable matrices");
    assert.equal(again.opaqueVertices, gpu.opaqueVertices, "all frames reuse one rest mesh");
    if (poses.resolve(request, true)) hdEligible++;
    checked++;
    return true;
}

for (const id of [1, 8, 9, 13, 19, 26, 3106, 3110, 388]) {
    const type = types.load(id), movement = type.getMovementSeqSet(factory.getBasTypeLoader());
    for (const sequence of [movement.idle, movement.walk]) {
        if (sequence < 0) continue;
        const seq = seqs.load(sequence);
        if (seq.isSkeletalSeq() || !seq.frameIds?.length) continue;
        for (let frame = 0; frame < Math.min(4, seq.frameIds.length); frame++) for (const alpha of [0, 0.5, 1]) {
            comparePose(id, sequence, frame, alpha);
        }
    }
}
assert.ok(checked >= 100, `at least100 actual cached NPC poses validated; got${checked}`);
assert.ok(types.load(2702).retextureFrom?.length, "the Reacher fixture has a real NPC retexture");
assert.ok(comparePose(2702, 808, 0, 0.5), "forced keyframes preserve retextured NPC appearance");
const man = types.load(3106), movement = man.getMovementSeqSet(factory.getBasTypeLoader());
const walk = seqs.load(movement.walk);
const originalMasks = walk.masks;
try {
    walk.masks = [1, 2, 3, 9999999];
    assert.ok(comparePose(3106, movement.walk, 0, 0.5, movement.idle, 0), "masked action/movement poses are supported");
} finally { walk.masks = originalMasks; }
assert.equal(poses.resolve([3106, movement.walk, 0, -1, -1, { base: { next: 1, alpha: 0.5 } }], true), undefined,
    "HD humanoid joints retain rebuilt posed normals rather than transformed rest normals");
assert.equal(poses.resolve([3106, movement.walk, 0], false), undefined, "integer CPU animation keeps its truncation behavior");
const contextRequest: Parameters<DynamicNpcAnimLoader["getFrameGeometry"]> = [3106, movement.walk, 0, -1, -1, { base: { next: 1, alpha: 0.5 } }];
let previous = poses.resolve(contextRequest, false)!;
for (const invalidate of [() => loader.clear(), () => CustomModelRegistry.clear(), () => loader.setTextureIdIndexMap(new Map(textureIds))]) {
    invalidate();
    const fresh = poses.resolve(contextRequest, false)!;
    assert.notEqual(fresh.key, previous.key, "content/session/texture changes create a fresh GPU identity");
    assert.notEqual(fresh.opaqueVertices, previous.opaqueVertices);
    assert.notEqual(fresh.matrices, previous.matrices);
    previous = fresh;
}
const originalWidth = man.widthScale;
try {
    man.widthScale = 144;
    const fresh = poses.resolve(contextRequest, false)!;
    assert.notEqual(fresh.key, previous.key, "in-place appearance changes cannot reuse the old rest mesh");
    assert.notEqual(fresh.opaqueVertices, previous.opaqueVertices);
    assert.equal(poses.resolve(contextRequest, false)!.opaqueVertices, fresh.opaqueVertices, "the new appearance stays warm after invalidation");
} finally { man.widthScale = originalWidth; }
const rawModels = loader.getModelLoader()!;
const savedGetModel = rawModels.getModel;
poses.resolve(contextRequest, false);
let repeatedModelBuilds = 0;
rawModels.getModel = (...request) => { repeatedModelBuilds++; return savedGetModel.apply(rawModels, request); };
try { poses.resolve(contextRequest, false); assert.equal(repeatedModelBuilds, 0, "cache hits never clone or relight the base model"); }
finally { rawModels.getModel = savedGetModel; }
const remapped = new Map(textureIds);
remapped.set(0, (remapped.get(0) ?? 1) + 1);
loader.setTextureIdIndexMap(remapped);
const retextured = poses.resolve([2702, 808, 0, -1, -1, { base: { next: 1, alpha: 0.5 } }], false)!;
const retextureWords = new Uint32Array(retextured.opaqueVertices.buffer, retextured.opaqueVertices.byteOffset, retextured.opaqueVertices.byteLength / 4);
let mappedTexture = false;
for (let i = 0; i < retextureWords.length; i += 5) if (retextureWords[i + 1] >>> 31) {
    assert.equal(((retextureWords[i + 1] >>> 22) & 511) | (((retextureWords[i + 2] >>> 5) & 1) << 9), remapped.get(0));
    mappedTexture = true;
}
assert.ok(mappedTexture, "the retextured fixture exercises the replacement texture-index map");
loader.setTextureIdIndexMap(textureIds);
const savedSource = loader.getGpuPoseSource;
const savedFrames = client.seqFrameLoader;
let rejectedSourceCalls = 0;
loader.getGpuPoseSource = (...request) => { rejectedSourceCalls++; return savedSource.apply(loader, request); };
client.seqFrameLoader = { load: () => { throw new Error("HD-ineligible poses must not load animation frames"); } };
try {
    const request: Parameters<DynamicNpcAnimLoader["getFrameGeometry"]> = [3106, movement.walk, 0, -1, -1, { base: { next: 1, alpha: 0.5 } }];
    assert.equal(poses.resolve(request, true), undefined);
    assert.equal(rejectedSourceCalls, 0, "HD jointed models are rejected before source/model/LabelPose work");
    const coldLoader = new DynamicNpcAnimLoader(types, factory.getModelLoader(), textureLoader, seqs, frames, factory.getSkeletalSeqLoader(), {} as any);
    coldLoader.setTextureIdIndexMap(textureIds);
    coldLoader.getModelLoader()!.getModel = () => { throw new Error("Cold HD models must build asynchronously"); };
    assert.equal(new NpcPoseGeometry(client, coldLoader, textureIds).resolve(request, true), undefined);
} finally { loader.getGpuPoseSource = savedSource; client.seqFrameLoader = savedFrames; }

// A single rigid label supports HD; transparency changes must fall back even with no base alphas.
const model = new Model();
model.verticesCount = 3; model.verticesX = new Int32Array([0, 128, 0]);
model.verticesY = new Int32Array([0, 0, -128]); model.verticesZ = new Int32Array(3);
model.faceCount = 1; model.indices1 = new Int32Array([0]); model.indices2 = new Int32Array([1]); model.indices3 = new Int32Array([2]);
model.faceColors1 = model.faceColors2 = model.faceColors3 = new Int32Array([100]);
model.vertexLabels = [[0, 1, 2]]; model.faceLabels = [[0]];
const base = new SeqBase(1, 2, [SeqTransformType.ORIGIN, SeqTransformType.ROTATE], [true, true], new Uint16Array([65535, 65535]), [[0], [0]]);
const frame = (angle: number, alpha = false, color = false) => new SeqFrame(2, base, 2, [0, 1], [0, 0], [0, angle], [0, 0], [-1, -1], alpha, color);
const rigidSeq = new SeqType(1, info); rigidSeq.frameIds = [0, 1];
let loaded = [frame(0), frame(32)];
let tinyKey = "rigid", ready = true;
const tinyClient: any = { textureLoader, seqTypeLoader: { load: () => rigidSeq }, seqFrameLoader: { load: (id: number) => loaded[id] } };
const shared = loader.getModelLoader()!;
const tinyLoader: any = { getContextKey: () => "tiny", peekBaseModel: () => model, getModelLoader: () => shared, getGpuPoseSource: () => ready ? ({
    key: tinyKey, baseKey: "rigid", baseModel: model,
    npcType: { widthScale: 128, heightScale: 128 }, frameId: 0, overlayFrameId: 0,
    interpolation: { base: { next: 1, alpha: 0.5 } },
}) : undefined };
const rigid = new NpcPoseGeometry(tinyClient, tinyLoader, textureIds);
let tinySourceCalls = 0;
const tinySource = tinyLoader.getGpuPoseSource;
tinyLoader.getGpuPoseSource = () => { tinySourceCalls++; return tinySource(); };
const rigidRequest: Parameters<DynamicNpcAnimLoader["getFrameGeometry"]> = [1, 1, 0, -1, -1, { base: { next: 1, alpha: 0.5 } }];
const saved = (shared as any).seqFrameLoader;
// Shared method uses its own frame loader, exactly as it does for real NPCs.
(shared as any).seqFrameLoader = tinyClient.seqFrameLoader;
try {
    assert.ok(rigid.resolve(rigidRequest, true), "a globally rigid animated NPC remains eligible with HD");
    tinyKey = "missing"; ready = false;
    assert.equal(rigid.resolve(rigidRequest, false), undefined);
    ready = true;
    assert.ok(rigid.resolve(rigidRequest, false), "streaming misses cannot poison later ready poses");
    tinyKey = "alpha";
    loaded = [frame(0, true), frame(32, true)];
    const callsBeforeRejection = tinySourceCalls;
    assert.equal(rigid.resolve(rigidRequest, false), undefined, "animated alpha cannot be hidden by an absent base alpha array");
    tinyKey = "color"; loaded = [frame(0, false, true), frame(32, false, true)];
    assert.equal(rigid.resolve(rigidRequest, false), undefined, "animated colour retains CPU shading");
    tinyKey = "skeletal"; loaded = [frame(0), frame(32)]; rigidSeq.skeletalId = 1;
    assert.equal(rigid.resolve(rigidRequest, false), undefined, "skeletal sequences retain the CPU path");
    assert.equal(tinySourceCalls, callsBeforeRejection, "unsupported animation frames never request or build a rest model");
    rigidSeq.skeletalId = -1;
    tinyKey = "no-rig"; model.vertexLabels = [];
    const unsupportedRig = new NpcPoseGeometry(tinyClient, tinyLoader, textureIds);
    assert.equal(unsupportedRig.resolve(rigidRequest, false), undefined, "models without labels retain the CPU path");
} finally { (shared as any).seqFrameLoader = saved; }

console.log(`NPC GPU positions: ${checked} poses, maximum error${largestPositionError.toFixed(7)} model units; HD rigid-eligible${hdEligible}`);
if (process.env.NPC_GPU_CAPTURE) console.log(`NPC_GPU_CAPTURE=${JSON.stringify(gpuReadbackCases)}`);
