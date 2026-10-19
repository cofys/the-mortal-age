import assert from "node:assert/strict";
import { test } from "node:test";

import { ActorDataTexture, MapActorUniforms } from "../render/webgpu/actors/actorGpu";

test("growing actor uniforms preserves every earlier draw's position and transform", () => {
    let uploaded = new ArrayBuffer(0);
    const device = {
        createTexture: () => ({ createView: () => ({}), destroy() {} }),
        createBindGroup: () => ({}),
        createBuffer: () => ({ destroy() {} }),
        queue: {
            writeTexture() {},
            writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer, start: number, size: number) => {
                uploaded = data.slice(start, start + size);
            },
        },
    } as unknown as GPUDevice;
    const uniforms = new MapActorUniforms(device, {} as GPUBindGroupLayout, 256, {
        mapX: 50, mapY: 50, borderSize: 0, heightMapSize: 2,
        heightMapTextureData: new Int16Array(16),
    } as any);
    for (const count of [9, 17, 33]) {
        uniforms.reset();
        for (let i = 0; i < count; i++) {
            uniforms.addEntry(50 + i, 51, 1.5, -10, i, 0, 0, 0);
        }
        uniforms.flush();
        const floats = new Float32Array(uploaded);
        const words = new Uint32Array(uploaded);
        for (let i = 0; i < count; i++) {
            const row = i * 64;
            assert.equal(floats[row], 50 + i, `position survives growth at ${count} draws`);
            assert.equal(words[row + 4], i, "actor data index is preserved");
            assert.equal(new Int32Array(uploaded)[row + 10], -1, "CPU poses remain CPU poses");
            assert.deepEqual(Array.from(floats.subarray(row + 16, row + 32)),
                [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                "the transform must never become a zero matrix");
        }
    }
    uniforms.destroy();
});

test("WebGPU actor textures skip unchanged uploads, but upload changes and resized rows", () => {
    let uploads = 0;
    const device = {
        createTexture: () => ({ createView: () => ({}), destroy() {} }),
        createBindGroup: () => ({}),
        queue: { writeTexture: () => uploads++ },
    } as unknown as GPUDevice;
    const texture = new ActorDataTexture(device, {} as GPUBindGroupLayout, "test");
    const data = new Uint16Array(128);
    texture.update(device, data, 1);
    texture.update(device, data, 1);
    assert.equal(uploads, 1);
    data[0] = 1;
    texture.update(device, data, 1);
    assert.equal(uploads, 2, "in-place actor movement is uploaded");
    texture.update(device, data, 9);
    assert.equal(uploads, 3, "a newly referenced row must be uploaded even if zero");
    texture.update(device, data, 1);
    assert.equal(uploads, 4);
    texture.update(device, data, 0);
    assert.equal(uploads, 4, "no actors need no upload");
    texture.destroy();
});
