import assert from "node:assert/strict";

import { MinimapRenderer } from "../widgets/gl/MinimapRenderer";

const uploads: Float32Array[] = [];
const draws: { count: number; texture: unknown; vertices: Float32Array }[] = [];
let texture: unknown;
let vertices: Float32Array;
const gl: any = {
    TRIANGLES: 4, ARRAY_BUFFER: 34962,
    useProgram() {}, uniformMatrix4fv() {}, uniform2f() {}, uniform1f() {}, uniform1i() {},
    activeTexture() {}, bindVertexArray() {}, bindBuffer() {}, texParameteri() {},
    bindTexture(_target: number, value: unknown) { texture = value; },
    bufferData(_target: number, data: Float32Array) {
        vertices = data.slice();
        uploads.push(vertices);
    },
    drawElements(_mode: number, count: number) {
        draws.push({ count, texture, vertices });
    },
    drawArrays(_mode: number, start: number, count: number) {
        assert.equal(start, 0);
        assert.equal(vertices.length, count * 4);
        draws.push({ count, texture, vertices });
    },
};
const renderer: any = Object.assign(Object.create(MinimapRenderer.prototype), {
    gl, proj: new Float32Array(16), dotInstances: [], dotBuffer: new Float32Array(24),
    quadVerts: new Float32Array(16), mask: null,
});
const a = { tex: {} as WebGLTexture, w: 4, h: 6 };
const b = { tex: {} as WebGLTexture, w: 2, h: 2 };
renderer.begin(40, 50, 76, 0, 1);
renderer.queueDot(a, 0, 0);
renderer.queueDot(b, 10, 20, 2);
renderer.queueDot(a, 2, 4, 0.5);
renderer.flushDots();

assert.equal(draws.length, 2, "one draw per texture, preserving the existing texture-group order");
assert.equal(uploads.length, 2, "one vertex upload per texture");
assert.deepEqual(draws.map(d => [d.texture, d.count]), [[a.tex, 12], [b.tex, 6]]);
const quad = (x0: number, y0: number, x1: number, y1: number) => [
    x0, y0, 0, 0, x1, y0, 1, 0, x1, y1, 1, 1,
    x0, y0, 0, 0, x1, y1, 1, 1, x0, y1, 0, 1,
];
assert.deepEqual([...draws[0].vertices], [...quad(38, 47, 42, 53), ...quad(41, 52.5, 43, 55.5)]);
assert.deepEqual([...draws[1].vertices], quad(48, 68, 52, 72));
const capacity = renderer.dotBuffer;
renderer.flushDots();
assert.equal(draws.length, 2, "an empty queue draws nothing");
renderer.begin(10, 20, 76, 512, 2);
renderer.queueDot(a, 2, 3);
renderer.flushDots();
assert.equal(renderer.dotBuffer, capacity, "reuse staging storage between frames");
const rotated = quad(14, 13, 18, 19);
draws[2].vertices.forEach((value, i) => {
    assert.ok(Math.abs(value - rotated[i]) < 0.01, "rotation, zoom and sprite dimensions are preserved");
});

renderer.begin(0, 0, 76, 0, 1);
for (let i = 0; i < 17000; i++) renderer.queueDot(a, i, 0);
renderer.flushDots();
assert.equal(draws.length, 4, "large groups stay one draw without a 16-bit index limit");
assert.equal(draws[3].count, 17000 * 6);
assert.equal(renderer.dotInstances.length, 0);
console.log("minimap dot batching tests passed");
