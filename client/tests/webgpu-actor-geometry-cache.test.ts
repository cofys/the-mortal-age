import assert from "node:assert/strict";
import { test } from "node:test";

import { ActorGeometryCache, type GpuGeometry } from "../render/webgpu/actors/actorGpu";
import { GPU_BUFFER_USAGE } from "../render/webgpu/bindings";

function fakeDevice() {
    const buffers: Array<GPUBuffer & { bytes: Uint8Array; destroys: number }> = [];
    const pending: Array<() => void> = [];
    const draws: number[][] = [];
    const device = {
        createBuffer: ({ size, usage }: GPUBufferDescriptor) => {
            const buffer = {
                size: Number(size), usage, bytes: new Uint8Array(Number(size)), destroys: 0,
                destroy() { this.destroys++; },
            };
            buffers.push(buffer as typeof buffers[number]);
            return buffer;
        },
        queue: {
            writeBuffer: (buffer: typeof buffers[number], offset: number, data: ArrayBufferView) => {
                assert.equal(buffer.destroys, 0);
                assert.equal(data.byteLength % 4, 0);
                assert.ok(offset + data.byteLength <= buffer.size);
                const copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
                pending.push(() => buffer.bytes.set(copy, offset));
            },
            submit: (geometries: GpuGeometry[]) => {
                pending.push(() => {
                    for (const geometry of geometries) {
                        draws.push(Array.from((geometry.vertices as typeof buffers[number]).bytes));
                    }
                });
            },
        },
    } as unknown as GPUDevice;
    return { device, buffers, draws, finish: () => { for (const op of pending.splice(0)) op(); } };
}

function pose(cache: ActorGeometryCache, key: string, value: number, bytes = 8, labels = false) {
    return cache.getOrCreate(key, new Uint8Array(bytes).fill(value), Int32Array.of(0, 1, 2),
        labels ? Uint32Array.of(value) : undefined)!;
}

test("actor buffers are reused after submission, never within the frame that evicted them", () => {
    const gpu = fakeDevice();
    const cache = new ActorGeometryCache(gpu.device, 1);
    const a = pose(cache, "a", 1, 8, true);
    const b = pose(cache, "b", 2, 8, true);
    const c = pose(cache, "c", 3, 8, true);
    assert.equal(gpu.buffers.length, 9, "evictions still belong to this frame's draws");
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("c"), c);
    gpu.device.queue.submit([a, b, c] as any);

    cache.beginFrame();
    const d = pose(cache, "d", 4, 8, true);
    assert.equal(gpu.buffers.length, 9, "the next pose reuses all three retired buffers");
    assert.equal(d.vertices, b.vertices);
    assert.equal(d.indices, b.indices);
    assert.equal(d.labels, b.labels);
    assert.equal(gpu.buffers.every((buffer) => buffer.destroys === 0), true);
    gpu.device.queue.submit([d] as any);
    gpu.finish();
    assert.deepEqual(gpu.draws, [1, 2, 3, 4].map((value) => Array(8).fill(value)),
        "queued old draws see old contents even when the GPU has not completed them at reuse");
    cache.destroy();
});

test("the free pool is byte bounded and matches both buffer size and usage", () => {
    const gpu = fakeDevice();
    const cache = new ActorGeometryCache(gpu.device, 1, 8);
    const a = pose(cache, "a", 1);
    pose(cache, "b", 2);
    cache.beginFrame();
    assert.equal((a.vertices as any).destroys, 0, "eight bytes fit the pool budget");
    assert.equal((a.indices as any).destroys, 1, "excess retired bytes are destroyed");
    const c = pose(cache, "c", 3);
    assert.equal(c.vertices, a.vertices);
    assert.notEqual(c.indices, a.indices);
    assert.equal(gpu.buffers.length, 5);
    cache.beginFrame();
    const d = cache.getOrCreate("d", new Uint8Array(12), Int32Array.of(0, 1))!;
    assert.notEqual(d.vertices, c.vertices, "a different vertex size needs its own storage");
    assert.notEqual(d.indices, a.vertices, "equal-sized vertex storage cannot be used as an index buffer");
    assert.equal(d.indices.usage, GPU_BUFFER_USAGE.INDEX | GPU_BUFFER_USAGE.COPY_DST);
    cache.destroy();
    assert.ok(gpu.buffers.every((buffer) => buffer.destroys === 1));
});

test("unaligned uploads are padded, and disposal clears live, retired and pooled buffers", () => {
    const gpu = fakeDevice();
    const cache = new ActorGeometryCache(gpu.device, 1);
    const a = pose(cache, "a", 1, 5, true);
    pose(cache, "b", 2, 5, true);
    cache.beginFrame();
    pose(cache, "c", 3, 12, true);
    gpu.finish();
    assert.equal(a.vertices.size, 8);
    assert.deepEqual(Array.from((a.vertices as any).bytes), [1, 1, 1, 1, 1, 0, 0, 0]);
    cache.getOrCreate("empty", new Uint8Array(), new Int32Array());
    assert.equal(cache.get("empty"), null);
    cache.destroy();
    cache.destroy();
    cache.beginFrame();
    assert.ok(gpu.buffers.every((buffer) => buffer.destroys === 1), "each allocation is destroyed exactly once");
    assert.equal(cache.get("c"), undefined);
    assert.equal(cache.get("empty"), undefined);
    const fresh = pose(cache, "c", 4);
    assert.ok(!gpu.buffers.slice(0, -2).includes(fresh.vertices as any), "invalidation leaves no old storage to reuse");
    cache.destroy();
});
