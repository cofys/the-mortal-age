import assert from "node:assert/strict";
import { test } from "node:test";

import { MapGeometryUpload, mapGeometrySources } from "../render/MapGeometryUpload";
import { WebGPUMapSquare } from "../render/webgpu/WebGPUMapSquare";
import { WebGPUInstances } from "../render/webgpu/instances";
import { getMapSquareId } from "../rs/map/MapFileIndex";

(globalThis as any).self = globalThis;
const { WebGLMapSquare } = require("../render/WebGLMapSquare");
const { takePreparedQueuedMap } = require("../render/render/streaming");
const { loadMap } = require("../render/render/map");

const MiB = 1024 * 1024;

function gpu() {
    const buffers: any[] = [], writes: { buffer: any; bytes: number; offset: number }[] = [];
    const device = {
        queue: {
            writeBuffer(buffer: any, offset: number, source: ArrayBufferView | ArrayBuffer) {
                const data = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
                buffer.bytes.set(data, offset);
                writes.push({ buffer, bytes: data.byteLength, offset });
            },
            writeTexture() {},
        },
        createBuffer({ size }: { size: number }) {
            const buffer = { bytes: new Uint8Array(size), released: false, destroy() { this.released = true; } };
            buffers.push(buffer);
            return buffer;
        },
        createTexture: () => ({ createView: () => ({}), destroy() {} }),
        createBindGroup: () => ({}),
    };
    return { device: device as any, buffers, writes };
}

function data() {
    const vertices = new Uint8Array(6 * MiB);
    for (let i = 0; i < vertices.length; i++) vertices[i] = (i * 31 + (i >> 10)) & 255;
    return {
        vertices, indices: new Int32Array([0, 1, 2]),
        mapX: 50, mapY: 50, borderSize: 0, heightMapSize: 1,
        modelTextureData: new Uint16Array(64), modelTextureDataAlpha: new Uint16Array(64),
        modelTextureDataLod: new Uint16Array(64), modelTextureDataLodAlpha: new Uint16Array(64),
        drawRanges: [{ offset: 0, elements: 3, bounds: [0, 0, 0, 1, 1, 1] }], drawRangesAlpha: [],
        drawRangesLod: [], drawRangesLodAlpha: [],
        tileRenderFlags: [], collisionDatas: [],
    } as any;
}

test("large map geometry copies across frames in bounded, byte-identical chunks", (t) => {
    t.mock.method(performance, "now", () => 0);
    const f = gpu(), d = data();
    const upload = new MapGeometryUpload(mapGeometrySources(d), (s) => f.device.createBuffer({ size: s.data.byteLength }),
        (b, bytes, offset) => f.device.queue.writeBuffer(b, offset, bytes), (b: any) => b.destroy());
    let steps = 0, done = false;
    while (!done) {
        const first = f.writes.length;
        done = upload.step(); steps++;
        const batch = f.writes.slice(first);
        assert.ok(batch.every((w) => w.bytes <= MapGeometryUpload.CHUNK_BYTES));
        assert.ok(batch.reduce((n, w) => n + w.bytes, 0) <= MapGeometryUpload.FRAME_BYTES);
    }
    assert.ok(steps > 1);
    const ready = upload.take();
    assert.deepEqual((ready.get(d.vertices) as any).bytes, d.vertices);
    assert.deepEqual((ready.get(d.indices) as any).bytes, new Uint8Array(d.indices.buffer));
    upload.dispose();
    assert.ok(f.buffers.every((b) => !b.released), "published buffers belong to the map");
});

test("an expensive upload yields after its current chunk and never exposes unfinished buffers", (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const f = gpu(), d = data();
    const upload = new MapGeometryUpload(mapGeometrySources(d), (s) => f.device.createBuffer({ size: s.data.byteLength }),
        (b, bytes, offset) => { f.device.queue.writeBuffer(b, offset, bytes); now += 3; }, (b: any) => b.destroy());
    assert.equal(upload.step(), false);
    assert.equal(f.writes.length, 1);
    assert.throws(() => upload.take(), /incomplete/);
    upload.dispose();
    assert.ok(f.buffers.every((b) => b.released));
});

test("the frame byte budget holds across differently sized vertex and index buffers", (t) => {
    t.mock.method(performance, "now", () => 0);
    const d = { vertices: new Uint8Array(MapGeometryUpload.FRAME_BYTES - 12), indices: new Int32Array(256) };
    const f = gpu();
    const upload = new MapGeometryUpload(mapGeometrySources(d), (s) => f.device.createBuffer({ size: s.data.byteLength }),
        (b, bytes, offset) => f.device.queue.writeBuffer(b, offset, bytes), (b: any) => b.destroy());
    assert.equal(upload.step(), false);
    assert.equal(f.writes.reduce((sum, w) => sum + w.bytes, 0), MapGeometryUpload.FRAME_BYTES);
    assert.equal(upload.step(), true);
    upload.dispose();
});

test("WebGPU consumes prepared buffers without uploading their geometry a second time", (t) => {
    t.mock.method(performance, "now", () => 0);
    const f = gpu(), d = data();
    while (!WebGPUMapSquare.prepareLoad(f.device, d)) {}
    const vertexBuffer = f.buffers[0], copies = f.writes.filter((w) => w.buffer === vertexBuffer).length;
    const square = WebGPUMapSquare.load(f.device, { mapUniformsLayout: {}, mapTexturesLayout: {} } as any, d, -1, 0);
    assert.equal(f.writes.filter((w) => w.buffer === vertexBuffer).length, copies);
    assert.deepEqual(vertexBuffer.bytes, d.vertices);
    square.delete();
    assert.equal(vertexBuffer.released, true);
    assert.equal((WebGPUMapSquare as any).pendingGeometry.size, 0);
});

test("superseded uploads release their buffers and cancellation respects device ownership", () => {
    const a = gpu(), b = gpu(), first = data(), second = data();
    assert.equal(WebGPUMapSquare.prepareLoad(a.device, first), false);
    assert.equal(WebGPUMapSquare.prepareLoad(b.device, second), false);
    WebGPUMapSquare.cancelPreparedLoads(a.device);
    assert.ok(a.buffers.every((buffer) => buffer.released));
    assert.ok(b.buffers.every((buffer) => !buffer.released));
    WebGPUMapSquare.cancelPreparedLoad(second);
    assert.ok(b.buffers.every((buffer) => buffer.released));
    assert.equal((WebGPUMapSquare as any).pendingGeometry.size, 0);
});

test("WebGL allocates indices by element count and copies the same bounded byte ranges", (t) => {
    t.mock.method(performance, "now", () => 0);
    const buffers: any[] = [], writes: number[] = [];
    const make = (size: number) => {
        const buffer = { bytes: new Uint8Array(size), released: false,
            data(bytes: Uint8Array, offset: number) { this.bytes.set(bytes, offset); writes.push(bytes.byteLength); },
            delete() { this.released = true; },
        };
        buffers.push(buffer);
        return buffer;
    };
    const app = {
        createInterleavedBuffer: (_stride: number, size: number) => make(size),
        createIndexBuffer: (_type: number, itemSize: number, count: number) => {
            assert.equal(itemSize, 3);
            return make(count * 4);
        },
    } as any;
    const d = data();
    assert.equal(WebGLMapSquare.prepareLoad(app, d), false);
    while (!WebGLMapSquare.prepareLoad(app, d)) {}
    assert.deepEqual(buffers[0].bytes, d.vertices);
    assert.deepEqual(buffers[1].bytes, new Uint8Array(d.indices.buffer));
    assert.ok(writes.every((bytes) => bytes <= MapGeometryUpload.CHUNK_BYTES));
    WebGLMapSquare.cancelPreparedLoads(app);
    assert.ok(buffers.every((buffer) => buffer.released));
    assert.equal((WebGLMapSquare as any).pendingGeometry.size, 0);
});

test("an instance remains busy and retains its built scene until its upload finishes", () => {
    const instances = new WebGPUInstances({} as any), scene = data();
    (instances as any).builtScene = scene;
    assert.equal(instances.takeBuiltScene(() => false), null);
    assert.equal(instances.hasPendingWork(), true);
    assert.equal(instances.takeBuiltScene(() => true), scene);
    assert.equal(instances.hasPendingWork(), false);
});

test("queued WebGL maps reject stale settings before copying and release only their staged buffers", () => {
    const buffers: any[] = [];
    const create = () => {
        const buffer = { released: false, data() {}, delete() { this.released = true; } };
        buffers.push(buffer);
        return buffer;
    };
    const app = { createInterleavedBuffer: create, createIndexBuffer: create };
    const d = data(), untouched = data();
    let valid = false;
    const queue: any[] = [d];
    const host = { app, pendingLocUpdates: new Set(), isValidMapData: () => valid,
        mapsToLoad: { peekFront: () => queue[0], shift: () => queue.shift() } } as any;
    try {
        assert.equal(takePreparedQueuedMap(host), d, "invalid data reaches the caller's batch cleanup and rejection");
        assert.equal(buffers.length, 0, "an already-invalid payload must not allocate or copy geometry");
        assert.equal(queue.length, 0);

        valid = true;
        queue.push(d);
        assert.equal(takePreparedQueuedMap(host), undefined);
        assert.equal(queue[0], d, "unfinished geometry stays queued");
        const staged = buffers.slice();
        assert.ok(staged.length > 0);
        assert.equal(WebGLMapSquare.prepareLoad(app, untouched), false);
        const ownedElsewhere = buffers.slice(staged.length);

        valid = false; // A settings/cache change while this payload was copying.
        assert.equal(takePreparedQueuedMap(host), d);
        assert.equal(queue.length, 0);
        assert.ok(staged.every((buffer) => buffer.released), "rejection must release every staged resource");
        assert.ok(ownedElsewhere.every((buffer) => !buffer.released), "another payload still owns its buffers");
    } finally {
        WebGLMapSquare.cancelPreparedLoads(app);
    }
});

test("an existing-map refresh releases staging that began before its loc-update flag", () => {
    const buffers: any[] = [];
    const create = () => {
        const buffer = { released: false, data() {}, delete() { this.released = true; } };
        buffers.push(buffer);
        return buffer;
    };
    const app = { createInterleavedBuffer: create, createIndexBuffer: create };
    const d = data(), untouched = data(), id = getMapSquareId(d.mapX, d.mapY);
    assert.equal(WebGLMapSquare.prepareLoad(app, d), false);
    const staged = buffers.slice();
    assert.equal(WebGLMapSquare.prepareLoad(app, untouched), false);
    const ownedElsewhere = buffers.slice(staged.length);
    let refreshes = 0;
    const existing = Object.create(WebGLMapSquare.prototype);
    existing.refreshSceneGeometry = () => { refreshes++; };
    const host = { app, osrsClient: {}, pendingLocUpdates: new Set([id]),
        pendingLocGeometryUpdates: new Set(), pendingDoorLocUpdates: new Set(),
        mapManager: { getMap: () => existing, addMap() {} },
        registerMinimapData() {}, updateTextureArray() {},
        rebuildGroundItemsForMap: () => false, groundItemStacks: new Map(),
    } as any;
    try {
        loadMap(host, {}, {}, {}, {}, {}, {}, {}, d);
        assert.equal(refreshes, 1, "the new loc-update flag still refreshes the resident map");
        assert.ok(staged.every((buffer) => buffer.released), "refresh allocations replace all staged buffers");
        assert.ok(ownedElsewhere.every((buffer) => !buffer.released), "another payload keeps its resources");
    } finally {
        WebGLMapSquare.cancelPreparedLoads(app);
    }
});
