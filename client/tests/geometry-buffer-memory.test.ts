import assert from "node:assert/strict";
import { test } from "node:test";

import { DataBuffer } from "../game/buffer/DataBuffer";
import { SceneBuffer } from "../render/buffer/SceneBuffer";
import { buildLocGeometryData } from "../render/loader/SdMapDataLoader";
import { compactSquareGeometry } from "../game/worker/MapSquareCache";

test("exactly filling geometry capacity does not double its backing buffer", () => {
    const buffer = new DataBuffer(12, 1024);
    buffer.bytes.fill(0x6d);
    const original = buffer.bytes.buffer;
    buffer.offset = 1023;
    assert.equal(buffer.ensureSize(1), false);
    assert.equal(buffer.bytes.buffer, original);
    buffer.offset++;
    assert.equal(buffer.ensureSize(1), true);
    assert.equal(buffer.bytes.byteLength, 2 * 1024 * 12);
    assert.ok(buffer.bytes.subarray(0, 1024 * 12).every((byte) => byte === 0x6d));
});

test("exported loc geometry transfers only used vertex bytes with identical content", () => {
    const scene = new SceneBuffer({} as any, new Map(), 4096);
    const vertices = scene.vertexBuf;
    vertices.addVertex(1, 2, 3, 1234, 0, 0, 0, -1);
    vertices.addVertex(4, 5, 6, 4321, 0, 0, 0, -1);
    const expected = vertices.byteArray().slice();
    const geometry = buildLocGeometryData(scene);
    assert.deepEqual(geometry.vertices, expected);
    assert.equal(geometry.vertices.buffer.byteLength, geometry.vertices.byteLength);
    assert.ok(geometry.vertices.buffer.byteLength < vertices.bytes.buffer.byteLength);
    const transferred = structuredClone(geometry, { transfer: [geometry.vertices.buffer] });
    assert.deepEqual(transferred.vertices, expected);
    assert.equal(transferred.vertices.buffer.byteLength, expected.byteLength);
    assert.deepEqual(vertices.byteArray(), expected, "export leaves the reusable builder intact");
});

test("old cached geometry sheds spare capacity once without changing its bytes", () => {
    const data = { vertices: new Uint8Array(32).subarray(0, 12),
        doorVertices: new Uint8Array(128).subarray(0, 0),
        npcVertices: new Uint8Array([1, 2, 3, 4]),
        loc: { vertices: new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4) },
    } as any;
    const expected = structuredClone(data), npc = data.npcVertices;
    assert.equal(compactSquareGeometry(data), true);
    assert.deepEqual(data, expected);
    assert.equal(data.vertices.buffer.byteLength, 12);
    assert.equal(data.doorVertices.buffer.byteLength, 0);
    assert.equal(data.loc.vertices.buffer.byteLength, 3);
    assert.equal(data.npcVertices, npc, "already compact arrays need no allocation");
    assert.equal(compactSquareGeometry(data), false);
});
