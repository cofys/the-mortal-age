// With a logged-in client and Chrome --remote-debugging-port=9333:
// CDP_PORT=9333 CLIENT_PORT=3000 node tests/ui-ordered-texture-batching.browser.cjs
const assert = require("node:assert/strict");
const WebSocket = require("ws");

async function main() {
    const tabs = await (await fetch(`http://localhost:${process.env.CDP_PORT || 9333}/json/list`)).json();
    const tab = tabs.find(tab => tab.type === "page" && tab.url.includes(`localhost:${process.env.CLIENT_PORT || 3000}`));
    assert.ok(tab, "Open the logged-in dev client in the specified Chrome instance");
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    try {
        await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("UI readback timed out")), 15000);
            socket.once("message", raw => {
                clearTimeout(timer);
                const response = JSON.parse(raw);
                const failure = response.error?.message || response.result?.exceptionDetails?.exception?.description;
                if (failure) reject(new Error(failure));
                else resolve(response.result.result.value);
            });
            socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
                expression: `(${compareBatches.toString()})()`, returnByValue: true,
            } }));
        });
        assert.equal(result.error, 0, "Mixed texture, masked and rotated draws must remain valid WebGL");
        assert.equal(result.different, 0, "Batches must preserve every channel of individually submitted draws");
        assert.ok(result.nonzero > 10000, "Readback must contain the rendered UI test pattern");
        assert.equal(result.alternatingDraws, 1, "Different texture/tint/alpha quads must share one draw");
        assert.ok(result.batchedDraws < result.immediateDraws / 2, "Mixed UI batching must reduce actual GL submissions");
        assert.deepEqual(result.rotatedAfterDeletion, result.rotatedBeforeDeletion,
            "Deleting a nonzero batch texture must not suppress the next immediate rotated draw");
        assert.ok(result.rotatedAfterDeletion.some(channel => channel > 0), "The rotated sprite must render");
        console.log("UI ordered texture batch readback passed:", result);
    } finally {
        socket.close();
    }
}

function compareBatches() {
    const client = window.osrsClient;
    const overlay = client.renderer.ui?.widgetsOverlay || client.renderer.widgetsOverlay;
    const canvas = document.createElement("canvas");
    const renderer = new overlay.glRenderer.constructor(canvas);
    renderer.resize(256, 192);
    const gl = renderer.gl;
    const textures = [];
    for (let index = 0; index < 10; index++) {
        const pixels = new Uint8Array(8 * 8 * 4);
        for (let i = 0; i < 64; i++) {
            pixels[i * 4] = (i * 43 + index * 31) % 256;
            pixels[i * 4 + 1] = (i * 17 + index * 59) % 256;
            pixels[i * 4 + 2] = (i * 71 + index * 13) % 256;
            pixels[i * 4 + 3] = (i + index) % 3 ? 255 : 95;
        }
        const texture = renderer.createTextureFromRgbaPixels(String(index), pixels, 8, 8);
        gl.bindTexture(gl.TEXTURE_2D, texture.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, index & 1 ? gl.NEAREST : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, index & 1 ? gl.NEAREST : gl.LINEAR);
        textures.push(texture);
    }
    const maskPixels = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        maskPixels[(y * 8 + x) * 4 + 3] = (x - 3.5) ** 2 + (y - 3.5) ** 2 < 12 ? 255 : 0;
    }
    const mask = renderer.createTextureFromRgbaPixels("mask", maskPixels, 8, 8);
    const quads = new Float32Array([
        8.25, 121.5, 0, 0, 37.5, 121.5, 0.5, 0, 37.5, 144.75, 0.5, 1, 8.25, 144.75, 0, 1,
        26.5, 130.25, 0.5, 0, 53.5, 130.25, 1, 0, 53.5, 154.5, 1, 1, 26.5, 154.5, 0.5, 1,
    ]);
    const read = immediate => {
        gl.disable(gl.SCISSOR_TEST);
        renderer.clear(0.15, 0.2, 0.3, 0.4);
        const start = renderer.getPerfCounters().drawCalls;
        const submit = action => { action(); if (immediate) renderer.flush(); };
        for (let i = 0; i < 32; i++) submit(() => renderer.drawTexture(
            textures[i % 2], 4.25 + i * 4, 5.75 + i % 4, 35.5, 29.25,
            1, 1, i % 3 / 2, [0.2, 0.6, i / 32], !!(i & 1), !!(i & 2), 0.3 + i % 5 / 8,
        ));
        renderer.flush();
        const alternatingDraws = renderer.getPerfCounters().drawCalls - start;
        for (let i = 0; i < 20; i++) submit(() => renderer.drawTexture(textures[i % 10], 8 + i * 8.25, 44, 31.5, 35.25));
        submit(() => renderer.drawRect(15, 50, 110, 8, [0.9, 0.4, 0.1, 0.35]));
        submit(() => renderer.drawTextureQuads(textures[3], quads, 2, 0.7, [0.3, 0.8, 0.2], 0.65));
        submit(() => renderer.drawTextureRotated(textures[1], 95.25, 100.5, 50.25, 31.75, 8192, 65536, 0.6, [0.8, 0.1, 0.6], 0.7));
        submit(() => renderer.drawTexture(textures[5], 120, 105, 35, 28));
        submit(() => renderer.drawTextureRotatedMasked(textures[6], mask, 151, 102, 45, 39, 53248));
        renderer.flush();
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(25, 12, 125, 38);
        for (let i = 0; i < 10; i++) submit(() => renderer.drawTexture(textures[i], 5 + i * 17, 140, 29, 45));
        renderer.flush();
        gl.disable(gl.SCISSOR_TEST);
        const pixels = new Uint8Array(256 * 192 * 4);
        gl.readPixels(0, 0, 256, 192, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { pixels, alternatingDraws, draws: renderer.getPerfCounters().drawCalls - start };
    };
    try {
        const immediate = read(true), batched = read(false);
        let different = 0, nonzero = 0;
        for (let i = 0; i < batched.pixels.length; i++) {
            if (immediate.pixels[i] !== batched.pixels[i]) different++;
            if (batched.pixels[i]) nonzero++;
        }
        const readRotatedPixel = () => {
            renderer.clear(0, 0, 0, 0);
            renderer.drawTextureRotated(textures[0], 0, 0, 32, 32, 0);
            const pixel = new Uint8Array(4);
            gl.readPixels(8, 184, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return Array.from(pixel);
        };
        const rotatedBeforeDeletion = readRotatedPixel();
        for (let i = 0; i < 8; i++) renderer.drawTexture(textures[i], i * 2, 0, 2, 2);
        renderer.flush();
        renderer.deleteTexture("3");
        const rotatedAfterDeletion = readRotatedPixel();
        return { different, nonzero, alternatingDraws: batched.alternatingDraws,
            immediateDraws: immediate.draws, batchedDraws: batched.draws,
            rotatedBeforeDeletion, rotatedAfterDeletion, error: gl.getError() };
    } finally {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
