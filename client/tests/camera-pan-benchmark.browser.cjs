// Log in on this worktree, stand at 3104,3508, and enable 117 HD, GPU,
// Animation Smoothing and Camera. Attach to your own Chrome debugging port:
// CDP_PORT=9333 CPU_SLOWDOWN=6 RENDER_SCALE=1 node tests/camera-pan-benchmark.browser.cjs /tmp/pan.json
// CPU throttling and extra rendered pixels are independent stress tests, not GPU emulation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

async function main() {
    const port = process.env.CDP_PORT;
    assert.ok(port, "Set CDP_PORT to your own Chrome debugging port");
    const env = fs.readFileSync(path.join(__dirname, "../../.env"), "utf8");
    const clientPort = process.env.CLIENT_PORT || env.match(/^PORT=(\d+)/m)?.[1];
    assert.ok(clientPort, "Missing worktree client port");
    const settings = {
        cpuSlowdown: Number(process.env.CPU_SLOWDOWN || 1),
        renderScale: Number(process.env.RENDER_SCALE || 1),
        durationMs: Number(process.env.DURATION_MS || 8000),
    };
    assert.ok(settings.cpuSlowdown >= 1 && settings.cpuSlowdown <= 20);
    assert.ok(settings.renderScale >= 1 && settings.renderScale <= 3);
    assert.ok(settings.durationMs >= 3000 && settings.durationMs <= 30000);
    const tabs = await (await fetch(`http://localhost:${port}/json/list`)).json();
    const tab = tabs.find(t => t.type === "page" && new URL(t.url).port === clientPort);
    assert.ok(tab, "Open the logged-in client on this worktree's port");
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let id = 0;
    const pending = new Map();
    socket.on("message", bytes => {
        const reply = JSON.parse(bytes);
        const callback = pending.get(reply.id);
        if (!callback) return;
        pending.delete(reply.id);
        callback(reply);
    });
    const send = async (method, params = {}) => {
        const reply = await new Promise((resolve, reject) => {
            const request = ++id;
            const timer = setTimeout(() => { pending.delete(request); reject(new Error(`${method} timed out`)); }, 120000);
            pending.set(request, response => { clearTimeout(timer); resolve(response); });
            socket.send(JSON.stringify({ id: request, method, params }));
        });
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
    };
    try {
        await send("Emulation.setCPUThrottlingRate", { rate: settings.cpuSlowdown });
        const result = await send("Runtime.evaluate", {
            expression: `(${benchmark.toString()})(${JSON.stringify(settings)})`,
            awaitPromise: true, returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        const data = result.result.value;
        assert.equal(data.errors.length, 0, "Benchmark encountered rendering errors");
        assert.ok(data.windows.every(w => w.samples.length > 20), "Too few gameplay frames");
        if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(data));
        console.log(JSON.stringify({ ...data, windows: data.windows.map(({ samples, ...w }) => w) }, null, 2));
    } finally {
        await send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
        socket.close();
    }
}

async function benchmark(settings) {
    const client = window.__osrsClient || window.osrsClient;
    const renderer = client?.renderer;
    if (client?.gameState !== 30 || renderer?.type !== "webgpu") throw new Error("Requires in-game WebGPU");
    if (client.widgetManager.rootInterface === 378) throw new Error("Dismiss the Welcome Screen before benchmarking");
    for (const name of ["117 HD", "GPU", "Animation Smoothing", "Camera"]) {
        const plugin = client.runeLite.pluginManager.getPlugins().find(p => p.getName() === name);
        if (!plugin?.isStarted()) throw new Error(`Enable ${name} before benchmarking`);
    }
    const player = client.playerEcs.getIndexForServerId(client.controlledPlayerServerId) ?? 0;
    const position = [client.playerEcs.getX(player) / 128, client.playerEcs.getY(player) / 128];
    if (Math.floor(position[0]) !== 3104 || Math.floor(position[1]) !== 3508 || client.playerEcs.getLevel(player) !== 0) {
        throw new Error(`Benchmark requires 3104,3508,0; currently ${position}`);
    }
    const sceneReady = renderer.mapManager.isSceneReady?.(renderer.stats.frameCount) ??
        (renderer.mapDataLoadedNotified && renderer.mapManager.visibleMaps.length > 0);
    if (!sceneReady) throw new Error("Wait for scene loading to finish");
    const originalRender = renderer.render;
    const originalScale = renderer.getCanvasResolutionScale;
    const yaw = client.camera.yaw, pitch = client.camera.pitch;
    const errors = [], windows = [];
    const restore = [];
    let work;
    const patch = (object, name, count) => {
        const original = object?.[name];
        if (typeof original !== "function") throw new Error(`Missing benchmark hook: ${name}`);
        object[name] = function(...args) {
            if (work) count(work, args);
            return original.apply(this, args);
        };
        restore.push(() => { object[name] = original; });
    };
    const texels = size => Array.isArray(size)
        ? size[0] * (size[1] ?? 1) * (size[2] ?? 1)
        : size.width * (size.height ?? 1) * (size.depthOrArrayLayers ?? 1);
    const onError = event => errors.push(String(event.error?.message || event.message));
    window.addEventListener("error", onError);
    renderer.device.addEventListener("uncapturederror", onError);
    const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
    const summary = values => ({
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        p50: percentile(values, .5), p95: percentile(values, .95),
        p99: percentile(values, .99), max: Math.max(...values),
    });
    try {
        patch(GPURenderPassEncoder.prototype, "drawIndexed", (w, [indices, instances = 1]) => {
            w.encodedIndexedDraws++; w.indexedDraws++; w.indices += indices * instances;
        });
        patch(GPURenderPassEncoder.prototype, "draw", (w, [vertices, instances = 1]) => {
            w.draws++; w.vertices += vertices * instances;
        });
        patch(GPURenderPassEncoder.prototype, "setPipeline", w => { w.pipelineBinds++; });
        const bundleEncoders = new WeakMap(), bundles = new WeakMap();
        const track = (object, name, run) => {
            const original = object[name];
            object[name] = function(...args) { return run.call(this, original, args); };
            restore.push(() => { object[name] = original; });
        };
        track(GPURenderBundleEncoder.prototype, "drawIndexed", function(original, args) {
            const counts = bundleEncoders.get(this) ?? { indexedDraws: 0, indices: 0 };
            counts.indexedDraws++;
            counts.indices += args[0] * (args[1] ?? 1);
            bundleEncoders.set(this, counts);
            if (work) work.encodedIndexedDraws++;
            return original.apply(this, args);
        });
        track(GPURenderBundleEncoder.prototype, "finish", function(original, args) {
            const bundle = original.apply(this, args);
            bundles.set(bundle, bundleEncoders.get(this) ?? { indexedDraws: 0, indices: 0 });
            if (work) work.bundleBuilds++;
            return bundle;
        });
        patch(GPURenderPassEncoder.prototype, "executeBundles", (w, [list]) => {
            for (const bundle of list) {
                const counts = bundles.get(bundle);
                if (!counts) throw new Error("Benchmark encountered a bundle recorded before its hooks");
                w.indexedDraws += counts.indexedDraws;
                w.indices += counts.indices;
                w.bundleExecutions++;
            }
        });
        patch(renderer.device, "createBuffer", (w, [descriptor]) => {
            w.bufferCreates++; w.bufferAllocatedBytes += descriptor.size;
        });
        // Re-record pre-existing scenery bundles during warm-up so replayed draws are counted.
        for (const map of [...renderer.mapManager.mapSquares.values(), renderer.editorOverlays?.preview?.square].filter(Boolean)) {
            for (const batch of [...map.opaqueBatches, ...map.alphaBatches]) batch.bundles = undefined;
        }
        patch(renderer.device.queue, "writeBuffer", (w, [, , data, offset = 0, size]) => {
            w.bufferWrites++;
            w.bufferBytes += size === undefined ? data.byteLength - offset * (data.BYTES_PER_ELEMENT ?? 1) : size * (data.BYTES_PER_ELEMENT ?? 1);
        });
        patch(renderer.device.queue, "writeTexture", (w, [, , , size]) => { w.textureWrites++; w.textureTexels += texels(size); });
        patch(renderer.device.queue, "copyExternalImageToTexture", (w, [, , size]) => { w.externalTextureCopies++; w.externalTexels += texels(size); });
        patch(GPUCommandEncoder.prototype, "copyTextureToTexture", (w, [, , size]) => { w.textureCopies++; w.copyTexels += texels(size); });
        patch(renderer.actors.dynamicNpcLoader, "cacheModelGeometry", w => { w.npcPoseBuilds++; });
        patch(renderer.world.extension.clutter, "build", w => { w.grassBuilds++; });
        renderer.getCanvasResolutionScale = function(w, h) { return originalScale.call(this, w, h) * settings.renderScale; };
        renderer.forceResize();
        const canvas = [renderer.canvas.width, renderer.canvas.height];
        // Four turns warm the bounded animation caches before alternating matched windows.
        for (const mode of ["warm", "idle", "drag", "drag", "idle"]) {
            const samples = [];
            client.camera.snapToYaw(0);
            client.camera.snapToPitch(256);
            renderer.followCamCameraFeelInitialized = false;
            let started;
            renderer.render = function(time, dt, resized) {
                started ??= time;
                if (time - started >= 1500 && !work) work = { indexedDraws: 0, encodedIndexedDraws: 0, bundleExecutions: 0, bundleBuilds: 0,
                    bufferCreates: 0, bufferAllocatedBytes: 0, draws: 0, indices: 0,
                    vertices: 0, pipelineBinds: 0, bufferWrites: 0, bufferBytes: 0,
                    textureWrites: 0, textureTexels: 0, textureCopies: 0, copyTexels: 0,
                    externalTextureCopies: 0, externalTexels: 0,
                    npcPoseBuilds: 0, grassBuilds: 0 };
                if (mode !== "idle") client.inputManager._cameraDragDeltaX = -512 * dt / 1000 / .9;
                const begin = performance.now();
                try { return originalRender.call(this, time, dt, resized); }
                finally {
                    if (time - started >= 1500) samples.push({ time, dt, cpu: performance.now() - begin, yaw: client.camera.yaw });
                }
            };
            await new Promise(resolve => setTimeout(resolve, mode === "warm" ? 16000 : settings.durationMs));
            renderer.render = originalRender;
            const counts = work;
            work = undefined;
            if (mode === "warm") continue;
            if (!samples.length) throw new Error("No gameplay frames recorded");
            const drainStart = performance.now();
            await renderer.device.queue.onSubmittedWorkDone();
            windows.push({ mode, frames: samples.length, cpuMs: summary(samples.map(f => f.cpu)),
                frameIntervalMs: summary(samples.map(f => f.dt)),
                gapsOver25ms: samples.filter(f => f.dt > 25).length,
                queueDrainMs: performance.now() - drainStart,
                work: counts, perFrame: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / samples.length])),
                fps: (samples.length - 1) * 1000 / (samples.at(-1).time - samples[0].time),
                maps: renderer.mapManager.visibleMaps.map(m => [m.mapX, m.mapY]), samples });
        }
        return { settings, position, canvas, gpu: client.clientPlugins.gpuSettings(),
            cssCanvas: [renderer.canvas.clientWidth, renderer.canvas.clientHeight],
            sceneViewport: renderer.getSceneViewportWidgetRect(),
            cameraViewport: [client.camera.viewportWidth, client.camera.viewportHeight],
            hd: renderer.world.extension.options(),
            browser: navigator.userAgent, scripts: [...document.scripts].map(s => s.src).filter(Boolean), windows, errors };
    } finally {
        renderer.render = originalRender;
        work = undefined;
        for (const undo of restore.reverse()) undo();
        renderer.getCanvasResolutionScale = originalScale;
        client.inputManager._cameraDragDeltaX = 0;
        client.camera.snapToYaw(yaw);
        client.camera.snapToPitch(pitch);
        renderer.forceResize();
        window.removeEventListener("error", onError);
        renderer.device.removeEventListener("uncapturederror", onError);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
