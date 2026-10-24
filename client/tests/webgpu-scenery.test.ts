import assert from "node:assert/strict";
import { test } from "node:test";

import { Frustum } from "../game/Frustum";
import { newDrawRange, type DrawRange } from "../render/DrawRange";
import { MAP_UNIFORMS_GROUP } from "../render/webgpu/bindings";
import { WebGPUMapSquare, type SceneryDrawContext } from "../render/webgpu/WebGPUMapSquare";

function range(offset: number, elements: number, x: number, chunk = true): DrawRange {
    const r = newDrawRange(offset, elements);
    r.bounds = [x, -1, 0, x + 8, 1, 8];
    if (chunk) r.chunk = [x, 0];
    return r;
}

function fixture(full: DrawRange[], far: DrawRange[], planes?: Uint8Array) {
    const device = {
        queue: { writeBuffer() {}, writeTexture() {} },
        createBuffer: (descriptor: unknown) => ({ descriptor, destroy() {} }),
        createTexture: () => ({ createView: () => ({}), destroy() {} }),
        createBindGroup: (descriptor: unknown) => descriptor,
    };
    const geometry = {
        vertices: new Uint8Array(48), indices: new Int32Array(256),
        modelTextureData: new Uint16Array(64), modelTextureDataAlpha: new Uint16Array(64),
        modelTextureDataLod: new Uint16Array(64), modelTextureDataLodAlpha: new Uint16Array(64),
        drawRanges: full, drawRangesAlpha: [], drawRangesPlanes: planes,
        drawRangesLod: far, drawRangesLodAlpha: [],
    };
    const data = {
        ...geometry, mapX: 0, mapY: 0, borderSize: 0, heightMapSize: 1,
        heightMapTextureData: new Int16Array(4), waterMaskTextureData: new Uint8Array(4),
        doorVertices: new Uint8Array(), doorIndices: new Int32Array(),
        doorDrawRanges: [], doorDrawRangesAlpha: [],
        collisionDatas: Array.from({ length: 4 }, () => ({
            sizeX: 64, sizeY: 64, flags: new Int32Array(64 * 64),
        })),
        tileRenderFlags: [], locsAnimated: [], loc: geometry,
    };
    // Scene and loc groups use the same fixture ranges; make scene empty for draw assertions.
    data.drawRanges = [];
    data.drawRangesLod = [];
    const resources = { depthPipelines: [{}, {}], depthTextureBindGroup: {} };
    const square = WebGPUMapSquare.load(device as any, resources as any, data as any, 0, 0);
    const draws: { count: number; first: number; uniform: number }[] = [];
    let uniform = -1;
    const pass = {
        setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {},
        setBindGroup(group: number, _binding: unknown, offsets?: number[]) {
            if (group === MAP_UNIFORMS_GROUP) uniform = offsets![0];
        },
        drawIndexed(count: number, _instances: number, first: number) {
            draws.push({ count, first, uniform });
        },
    } as unknown as GPURenderPassEncoder;
    const context: SceneryDrawContext = {
        tileX: 0, tileZ: 0, distance: 40, lodDistance: 8,
        camera: { intersectsBox: (box: number[][]) => box[0][0] < 40 } as Frustum,
    };
    return { square, draws, pass, context, data, device, resources };
}

test("WebGPU editor previews load and draw without collision metadata", () => {
    const f = fixture([range(0, 6, 0)], []);
    const preview = WebGPUMapSquare.load(f.device as any, f.resources as any,
        { ...f.data, collisionDatas: undefined } as any, -1, 0);
    assert.deepEqual(preview.collisionMaps, []);
    assert.equal(preview.getCollisionFlag(0, 7, 9), 0);
    preview.drawOpaque(f.pass, 3, f.context);
    assert.equal(f.draws.length, 1, "draw-only previews still render their model");
    preview.delete();
    f.square.delete();
});

test("WebGPU retains collision flags and refreshes them with scenery metadata", () => {
    const f = fixture([], []);
    f.data.collisionDatas[2].flags[7 + 9 * 64] = 0x20100;
    assert.equal(f.square.getCollisionFlag(2, 7, 9), 0x20100);
    assert.equal(f.square.getCollisionFlag(1, 7, 9), 0);
    const collisionDatas = f.data.collisionDatas.map(data => ({ ...data, flags: data.flags.slice() }));
    collisionDatas[2].flags[7 + 9 * 64] = 0;
    f.square.refreshPartial({ ...f.data, collisionDatas, locOnly: true } as any, {} as any, 1);
    assert.equal(f.square.getCollisionFlag(2, 7, 9), 0);
    f.square.delete();
});

test("WebGPU selects one scenery tier per chunk, culls fog/frustum and keeps unchunked items", () => {
    const f = fixture([range(0, 6, 0), range(24, 12, 24), range(72, 18, 64), range(144, 3, 24, false)],
        [range(156, 3, 0), range(168, 3, 24), range(180, 3, 64)]);
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.deepEqual(f.draws.map(d => [d.first, d.count]), [[0, 6], [36, 3], [42, 3]]);
    const batches = (f.square as any).opaqueBatches;
    assert.equal(batches[0].vertexBuffer, batches[1].vertexBuffer, "tiers share the baked mesh buffers");
    assert.equal(batches[0].indexBuffer, batches[1].indexBuffer);
    f.square.delete();
});

test("WebGPU shadows use full geometry and the light frustum, including off-screen casters", () => {
    const f = fixture([range(0, 6, 0), range(24, 12, 64)], [range(72, 3, 64)]);
    f.square.drawDepth(f.pass, 3, { ...f.context,
        shadow: { intersectsBox: (box: number[][]) => box[1][0] >= 64 } as Frustum });
    assert.deepEqual(f.draws.map(d => [d.first, d.count]), [[6, 12]]);
    f.square.delete();
});

test("WebGPU rejects an off-screen batch without testing each range", () => {
    const f = fixture(Array.from({ length: 200 }, (_, i) => range(i * 24, 6, 80 + i)), []);
    let tests = 0;
    f.context.distance = 1000;
    f.context.camera = { intersectsBox: (box: number[][]) => { tests++; return box[0][0] < 40; } } as Frustum;
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(f.draws.length, 0);
    assert.equal(tests, 1, "one conservative batch test replaces 200 rejected range tests");
    f.square.delete();
});

test("WebGPU batch bounds preserve per-range draws across camera, fog, roofs and shadows", () => {
    const full = Array.from({ length: 80 }, (_, i) => range(i * 24, 6, (i * 17) % 128 - 32));
    const far = full.map((r, i) => range((80 + i) * 24, 6, r.bounds![0]));
    const f = fixture(full, far, Uint8Array.from(full, (_, i) => i % 4));
    const batches = (f.square as any).opaqueBatches;
    const bounds = batches.map((batch: any) => batch.bounds);
    for (const shadow of [false, true]) for (const roof of [0, 3]) for (let x = -64; x <= 128; x += 8) {
        const frustum = { intersectsBox: (box: number[][]) => box[0][0] <= x + 24 && box[1][0] >= x } as Frustum;
        const context = { ...f.context, tileX: x, distance: 32, camera: frustum,
            shadow: shadow ? frustum : undefined };
        f.draws.length = 0;
        batches.forEach((batch: any, i: number) => batch.bounds = bounds[i]);
        f.square.drawOpaque(f.pass, roof, context);
        const bounded = f.draws.slice();
        f.draws.length = 0;
        batches.forEach((batch: any) => batch.bounds = undefined);
        f.square.drawOpaque(f.pass, roof, context);
        assert.deepEqual(bounded, f.draws, `same draws at x=${x}, roof=${roof}, shadow=${shadow}`);
    }
    f.square.delete();
});

test("WebGPU keeps batches containing unbounded animation ranges conservative", () => {
    const unbounded = newDrawRange(24, 6);
    const f = fixture([range(0, 6, 80), unbounded], []);
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.deepEqual(f.draws.map(d => [d.first, d.count]), [[6, 6]]);
    assert.equal((f.square as any).opaqueBatches[0].bounds, undefined);
    f.square.delete();
});

test("WebGPU coalesces identical contiguous terrain, but never across a hidden roof range", () => {
    const full = [range(0, 6, 0), range(24, 6, 0), range(48, 6, 0), range(72, 6, 0)];
    full.forEach(r => r.batchKey = 1);
    const f = fixture(full, [], new Uint8Array([0, 0, 1, 0]));
    f.square.drawOpaque(f.pass, 0, f.context);
    assert.deepEqual(f.draws.map(d => [d.first, d.count, d.uniform]), [[0, 12, 0], [18, 6, 768]]);
    f.square.delete();
});

test("WebGPU boat decks bypass world-coordinate culling and always use full geometry", () => {
    const f = fixture([range(0, 6, 200)], [range(24, 3, 200)]);
    f.square.setWorldEntityTransform(new Float32Array(16));
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.deepEqual(f.draws.map(d => [d.first, d.count]), [[0, 6]]);
    f.square.delete();
});

test("WebGPU advances both full and far animated ranges to the same baked frame", () => {
    const full = [range(0, 6, 0)], far = [range(24, 6, 24)];
    const fullRange = full[0], farRange = far[0];
    const f = fixture(full, far);
    const frame = range(48, 12, 24);
    f.square.locsAnimated = [{ frame: 0, anim: { frames: [frame] }, update() {}, drawFrame: () => 0,
        drawRangeIndex: 0, drawRangeLodIndex: 0, drawRangeAlphaIndex: -1, drawRangeLodAlphaIndex: -1,
        getDrawRangeIndex: (alpha: boolean) => alpha ? -1 : 0 } as any];
    f.square.updateAnimatedLocs({} as any, 10);
    assert.equal(full[0], fullRange);
    assert.equal(far[0], farRange);
    assert.deepEqual(full[0].slice(0, 2), [48, 12]);
    assert.deepEqual(far[0].slice(0, 2), [48, 12]);
    assert.deepEqual(full[0].chunk, [0, 0]);
    assert.deepEqual(far[0].chunk, [24, 0]);
    f.square.delete();
});

test("WebGPU advances and selects scenery once per cycle across high-FPS and shadow passes", () => {
    const full = [range(0, 6, 0)], far = [range(24, 6, 24)];
    const f = fixture(full, far);
    let advances = 0, selections = 0, sounds = 0;
    const loc = { anim: { frames: [range(48, 12, 24)] },
        update(_loader: unknown, _cycle: number, sound?: () => void) { advances++; sound?.(); },
        drawFrame() { selections++; return 0; },
        drawRangeIndex: 0, drawRangeLodIndex: 0, drawRangeAlphaIndex: -1, drawRangeLodAlphaIndex: -1,
        getDrawRangeIndex: (alpha: boolean) => alpha ? -1 : 0 } as any;
    f.square.locsAnimated = [loc];
    const sound = () => sounds++;
    for (let frame = 0; frame < 5; frame++) {
        f.square.updateAnimatedLocs({} as any, 10, sound);
        f.square.updateAnimatedLocs({} as any, 10);
    }
    assert.equal(advances, 1, "240 FPS and HD shadows share one 20 ms animation update");
    assert.equal(selections, 1, "full/far opaque/alpha share the same baked-frame selection");
    assert.equal(sounds, 1);
    f.square.updateAnimatedLocs({} as any, 11);
    f.square.updateAnimatedLocs({} as any, 11, sound);
    assert.equal(advances, 3, "a visible pass may deliver sound after a shadow-only update");
    assert.equal(selections, 2, "a late sound callback need not rewrite geometry");
    assert.equal(sounds, 2);
    f.square.locsAnimated = [{ ...loc }];
    f.square.updateAnimatedLocs({} as any, 11, sound);
    assert.equal(selections, 3, "replacing the loc list invalidates within the same cycle");
    const replacement = range(72, 18, 0);
    f.square.refreshPartial({ ...f.data, locOnly: true,
        loc: { ...f.data.loc, drawRanges: [replacement] } } as any, {} as any, 1);
    f.square.locsAnimated = [loc];
    f.square.updateAnimatedLocs({} as any, 11, sound);
    assert.deepEqual(replacement.slice(0, 3), [48, 12, 1], "new geometry is repaired in the same cycle");
    assert.equal(selections, 4);
    f.square.delete();
});

test("WebGPU partial loc rebuilds replace animation bounds and keep them while frames advance", () => {
    const f = fixture([range(0, 6, 0)], []);
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(f.draws.length, 1);
    const replacement = range(24, 12, 80);
    f.square.refreshPartial({ ...f.data, locOnly: true,
        loc: { ...f.data.loc, drawRanges: [replacement] } } as any, {} as any, 1);
    f.square.locsAnimated = [{ anim: { frames: [range(48, 6, 80)] }, update() {}, drawFrame: () => 0,
        drawRangeIndex: 0, drawRangeLodIndex: -1, drawRangeAlphaIndex: -1, drawRangeLodAlphaIndex: -1,
        getDrawRangeIndex: (alpha: boolean, _interact: boolean, lod: boolean) => alpha || lod ? -1 : 0 } as any];
    f.square.updateAnimatedLocs({} as any, 10);
    assert.deepEqual(replacement.bounds, [80, -1, 0, 88, 1, 8]);
    f.draws.length = 0;
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(f.draws.length, 0, "the replacement no longer inherits the old visible bounds");
    f.context.tileX = 80;
    f.context.camera = { intersectsBox: () => true } as unknown as Frustum;
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.deepEqual(f.draws.map(d => [d.first, d.count]), [[12, 6]], "the new pose renders when its bounds are in view");
    f.square.delete();
});


test("WebGPU wall previews give each placement its own uniform slot", () => {
    const f = fixture([range(0, 6, 0)], []);
    const first = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
    const second = first.slice(); second[12] = 20;
    f.square.setWorldEntityTransforms([first, second]);
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.deepEqual(f.draws.map(draw => draw.uniform), [0, 256], "copies cannot share the last matrix uploaded");
    f.draws.length = 0;
    f.square.setWorldEntityTransforms([first]);
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(f.draws.length, 1, "shortening a wall removes old preview copies");
    f.draws.length = 0;
    f.square.setWorldEntityTransforms([]);
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(f.draws.length, 0, "clearing previews leaves no phantom copy");
    f.square.delete();
});

test("WebGPU bundles replay exact draws and invalidate for animation, roofs, pipelines and partial reloads", () => {
    const f = fixture([range(0, 6, 0, false), range(24, 12, 8, false)], [], new Uint8Array([0, 1]));
    const tracker = enableBundles(f);
    const descriptors = tracker.descriptors;
    Object.assign(f.resources, { opaquePipeline: {}, alphaPipeline: {}, canvasFormat: "bgra8unorm", sampleCount: 4 });
    const draw = () => { f.draws.length = 0; f.square.drawOpaque(f.pass, 3, f.context); return f.draws.map(d => ({ ...d })); };
    const direct = draw();
    assert.deepEqual(draw(), direct);
    assert.deepEqual(draw(), direct);
    assert.equal(tracker.builds, 1);
    assert.equal(tracker.executions, 2);
    assert.deepEqual(descriptors[0], { colorFormats: ["bgra8unorm"], depthStencilFormat: "depth32float", sampleCount: 4 });
    const batch = (f.square as any).opaqueBatches[0];
    batch.ranges[1][0] = 96;
    const animated = draw();
    assert.notDeepEqual(animated, direct, "animated frame's index offset is part of the command signature");
    assert.equal(tracker.executions, 2, "changed lists use immediate commands before being cached");
    assert.deepEqual(draw(), animated);
    assert.equal(tracker.builds, 2);
    f.draws.length = 0;
    f.square.drawOpaque(f.pass, 0, f.context);
    assert.equal(f.draws.length, 1, "roof change never replays an obsolete second draw");
    Object.assign(f.resources, { opaquePipeline: {}, sampleCount: 1, extensionActive: true,
        extension: { sceneColorFormat: "rgba16float" } });
    draw(); draw();
    assert.equal(descriptors.at(-1).sampleCount, 1);
    assert.deepEqual(descriptors.at(-1).colorFormats, ["rgba16float"]);
    f.square.refreshPartial({ ...f.data, locOnly: true } as any, {} as any, 1);
    const before = tracker.builds;
    draw();
    assert.equal(tracker.builds, before, "replacement GPU resources do not reuse the old bundle");
    draw();
    assert.equal(tracker.builds, before + 1);
    f.square.drawDepth(f.pass, 3, f.context);
    f.square.drawDepth(f.pass, 3, f.context);
    assert.deepEqual(descriptors.at(-1).colorFormats, []);
    assert.equal(descriptors.at(-1).sampleCount, 1);
    f.square.delete();
});

function enableBundles(f: ReturnType<typeof fixture>) {
    const tracker = { builds: 0, executions: 0, descriptors: [] as any[] };
    (f.device as any).createRenderBundleEncoder = (descriptor: any) => {
        tracker.descriptors.push(descriptor);
        const calls: [string, any[]][] = [];
        return Object.fromEntries([
            ...["setPipeline", "setBindGroup", "setVertexBuffer", "setIndexBuffer", "drawIndexed"].map(name =>
                [name, (...args: any[]) => { calls.push([name, args]); }]),
            ["finish", () => { tracker.builds++; return calls; }],
        ]);
    };
    (f.pass as any).executeBundles = (bundles: [string, any[]][][]) => {
        tracker.executions++;
        for (const bundle of bundles) for (const [name, args] of bundle) (f.pass as any)[name](...args);
    };
    return tracker;
}

test("one animated range only invalidates its small bundle section", () => {
    const f = fixture(Array.from({ length: 65 }, (_, i) => range(i * 24, 6, 0, false)), []);
    const tracker = enableBundles(f);
    Object.assign(f.resources, { opaquePipeline: {}, canvasFormat: "bgra8unorm", sampleCount: 1 });
    for (let i = 0; i < 3; i++) f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(tracker.builds, 2, "two 32-range bundles; the final single draw stays direct");
    const batches = (f.square as any).opaqueBatches;
    batches[0].ranges[0][0] = 4000;
    f.draws.length = 0;
    const before = tracker.executions;
    f.square.drawOpaque(f.pass, 3, f.context);
    assert.equal(tracker.executions, before + 1, "unchanged section still replays");
    assert.equal(f.draws.length, 65);
    assert.equal(f.draws[0].first, 1000);
    assert.equal(f.draws[64].first, 384);
    f.square.delete();
});
