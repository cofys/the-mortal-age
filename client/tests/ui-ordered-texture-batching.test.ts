import assert from "node:assert/strict";

import { GLRenderer } from "../widgets/gl/renderer";

function fixture() {
    const draws: { count: number; vertices: Float32Array }[] = [];
    const events: string[] = [];
    let uploaded = new Float32Array(0);
    const gl: any = new Proxy({
        ARRAY_BUFFER: 34962, TEXTURE_2D: 3553, TEXTURE0: 33984, TRIANGLES: 4,
        getParameter: () => 16,
        getShaderParameter: () => true, getProgramParameter: () => true,
        getUniformLocation: (_program: unknown, name: string) => ({ name }),
        bufferData(target: number, data: Float32Array) { if (target === 34962) uploaded = data.slice(); },
        drawArrays(_mode: number, _first: number, count: number) {
            draws.push({ count, vertices: uploaded.slice() }); events.push("draw");
        },
        drawElements(_mode: number, count: number) {
            draws.push({ count, vertices: uploaded.slice() }); events.push("draw");
        },
        deleteTexture() { events.push("delete"); },
        texSubImage2D() { events.push("update"); },
    }, {
        get(target: any, key: string) {
            if (key in target) return target[key];
            if (/^[A-Z_0-9]+$/.test(key)) return 0;
            return (..._args: unknown[]) => key.startsWith("create") ? {} : undefined;
        },
    });
    const canvas: any = { width: 200, height: 100, getContext: () => gl };
    const renderer = new GLRenderer(canvas);
    renderer.resize(200, 100);
    return { renderer, draws, events };
}
const texture = () => ({ tex: {} as WebGLTexture, w: 16, h: 16 });

const { renderer, draws } = fixture();
const a = texture(), b = texture();
for (let i = 0; i < 32; i++) {
    renderer.drawTexture(i & 1 ? b : a, i, 2, 8, 8, 1, 1, i & 1, [i / 32, 0.5, 1], false, false, 0.5);
}
renderer.flush();
assert.equal(draws.length, 1, "texture and tint switches stay in one ordered UI batch");
assert.equal(draws[0].count, 32 * 6);
const data = draws[0].vertices;
assert.equal(data.length, 32 * 6 * 10);
for (let i = 0; i < 32; i++) for (let vertex = 0; vertex < 6; vertex++) {
    const offset = (i * 6 + vertex) * 10;
    assert.deepEqual([...data.subarray(offset + 4, offset + 10)], [i / 32, 0.5, 1, i & 1, 0.5, i & 1],
        "each triangle retains exact per-quad tint, alpha and original texture slot");
}

const limit = fixture();
for (let i = 0; i < 17; i++) limit.renderer.drawTexture(texture(), i, 0, 1, 1);
limit.renderer.flush();
assert.deepEqual(limit.draws.map(d => d.count), [8 * 6, 8 * 6, 6], "at most eight original textures are bound per batch");

const barriers = fixture();
barriers.renderer.drawTexture(a, 0, 0, 1, 1);
barriers.renderer.drawRect(0, 0, 1, 1, [1, 0, 0, 0.5]);
barriers.renderer.drawTexture(b, 0, 0, 1, 1);
barriers.renderer.flush();
assert.deepEqual(barriers.draws.map(d => d.count), [6, 6, 6], "solid/texture alpha order is unchanged");

for (const masked of [false, true]) {
    const state = fixture();
    state.renderer.drawTexture(a, 0, 0, 1, 1);
    if (masked) state.renderer.drawTextureRotatedMasked(a, b, 0, 0, 8, 8, 8192);
    else state.renderer.drawTextureRotated(a, 0, 0, 8, 8, 8192);
    state.renderer.drawTexture(b, 0, 0, 1, 1);
    state.renderer.flush();
    assert.deepEqual(state.draws.map(d => d.count), [6, 6, 6], "rotated/masked draws preserve ordered batch barriers");
    assert.deepEqual(state.draws.map(d => d.vertices.length), [60, 16, 60], "immediate draws keep their original UV layout");
}

for (const mutation of ["delete", "update"] as const) {
    const state = fixture();
    state.renderer.textures.set("a", a);
    state.renderer.drawTexture(a, 0, 0, 1, 1);
    state.renderer.drawTexture(b, 0, 0, 1, 1);
    if (mutation === "delete") state.renderer.deleteTexture("a");
    else state.renderer.updateTextureFromCanvas("a", { width: 16, height: 16 } as HTMLCanvasElement);
    assert.deepEqual(state.events, ["draw", mutation], "queued users are submitted before a texture changes");
}

const large = fixture();
large.renderer.drawTextureQuads(a, new Float32Array(6000 * 16), 6000);
large.renderer.flush();
assert.deepEqual(large.draws.map(d => d.count), [2048 * 6, 2048 * 6, 1904 * 6], "staging storage stays bounded for long text");
assert.ok((large.renderer as any).textureBatchTriangleData.byteLength <= 2048 * 60 * 4);
console.log("ordered UI texture batching tests passed");
