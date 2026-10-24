import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

require.extensions[".glsl"] = (module, file) => { module.exports = fs.readFileSync(file, "utf8"); };
for (const ext of [".png", ".jpg", ".webp"]) {
    require.extensions[ext] = (module, file) => { module.exports = file; };
}
(globalThis as any).self = globalThis;
Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Chrome", maxTouchPoints: 0, gpu: {} },
});
const { WebGLOsrsRenderer } = require("../render/WebGLOsrsRenderer");
const { WebGPURenderer } = require("../render/webgpu/WebGPURenderer");
const { pickRendererType, getAvailableRenderers } = require("../game/GameRenderers");

for (const scenario of [
    { name: "available adapter", supported: true, adapter: {}, selected: "webgpu" },
    { name: "API without an adapter", supported: true, adapter: undefined, selected: "webgl" },
    { name: "rejected adapter request", supported: true, error: true, selected: "webgl" },
    { name: "unsupported browser", supported: false, adapter: undefined, selected: "webgl" },
]) {
    test(`renderer choices follow ${scenario.name}`, async (t) => {
        t.mock.method(WebGLOsrsRenderer, "isSupported", () => true);
        t.mock.method(WebGPURenderer, "isSupported", () => scenario.supported);
        t.mock.method(WebGPURenderer, "probeAdapter", async () => {
            if (scenario.error) throw new Error("Adapter unavailable");
            return scenario.adapter;
        });
        assert.equal(await pickRendererType(), scenario.selected);
        assert.deepEqual(getAvailableRenderers(), scenario.adapter ? ["webgl", "webgpu"] : ["webgl"]);
    });
}
