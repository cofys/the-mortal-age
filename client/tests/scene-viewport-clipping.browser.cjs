// With yarn start and a logged-in Chrome tab launched using
// --remote-debugging-port=9333, run: yarn --cwd client test:scene-viewport
// Checks the resolved scene texture before UI composition (screenshots can be
// misleading under SwiftShader). Run in fixed and resizable layouts, at each DPR.
const assert = require("node:assert/strict");
const WebSocket = require("ws");

async function main() {
    const tabs = await (await fetch("http://localhost:9333/json/list")).json();
    const tab = tabs.find((tab) => tab.type === "page" && tab.url.includes("localhost:3000"));
    assert.ok(tab, "Open the dev client in Chrome on debugging port 9333");
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    try {
        await new Promise((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("No scene frame within 15 seconds")), 15000);
            socket.once("message", (raw) => {
                clearTimeout(timer);
                const response = JSON.parse(raw);
                if (response.error || response.result?.exceptionDetails) {
                    reject(new Error(JSON.stringify(response)));
                } else {
                    resolve(response.result.result.value);
                }
            });
            socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
                awaitPromise: true, returnByValue: true,
                expression: `(${captureScene.toString()})()`,
            } }));
        });
        assert.equal(result.scissorAtBlit, false, "Scene clipping must end before blitting and UI drawing");
        assert.equal(result.readError, 0, "Scene texture readback must succeed");
        assert.ok(result.inside > 0, "The viewport must contain rendered scene pixels");
        assert.equal(result.outside, 0, "Pixels outside the scene viewport must remain black");
        assert.equal(result.overlays.readError, 0, "World overlay readback must succeed");
        assert.ok(result.overlays.inside > 0, "World overlays must preserve the scene");
        assert.equal(result.overlays.outside, 0, "World overlays must stay inside the scene viewport");
        assert.equal(result.scissorAtWidgets, false, "World clipping must not clip the gameframe UI");
        if (result.root === 548) {
            const { metrics, canvasWidth } = result;
            const scale = Math.max(1, Math.round(canvasWidth / result.cssWidth));
            const offsetX = Math.max(0, Math.floor((canvasWidth - 765 * scale) / 2));
            const offsetY = 0;
            assert.deepEqual(metrics, {
                layoutW: 765, layoutH: 503,
                renderScaleX: scale, renderScaleY: scale,
                renderOffsetX: offsetX, renderOffsetY: offsetY,
            }, "Fixed frames must be top-centered without stretching, even on HiDPI displays");
            assert.deepEqual(result.viewport, {
                x: offsetX + 4 * scale, y: offsetY + 4 * scale,
                width: 512 * scale, height: 334 * scale,
            }, "The scene must share the fixed frame's transform");
            assert.equal(result.viewportBlockedByUI, false,
                "Resizable UI regions must not block the centered fixed viewport");
        }
        console.log("Scene viewport clipping passed:", result);
    } finally {
        socket.close();
    }
}

function captureScene() {
    return new Promise((resolve, reject) => {
        const client = window.osrsClient;
        const renderer = client.renderer;
        const { app, gl } = renderer;
        const widgets = renderer.widgetsOverlay;
        const original = app.blitFramebuffer;
        const originalWidgetsDraw = widgets.draw;
        let scene;
        const restore = () => {
            app.blitFramebuffer = original;
            widgets.draw = originalWidgetsDraw;
            clearTimeout(timer);
        };
        const timer = setTimeout(() => {
            restore();
            reject(new Error("No scene frame; log in and dismiss the welcome screen"));
        }, 10000);
        function readPixels(framebuffer) {
            const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
            try {
                const viewport = renderer.getSceneViewportWidgetRect();
                const pixels = new Uint8Array(app.width * app.height * 4);
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
                // Discard earlier GL errors so the assertion concerns this readback.
                while (gl.getError() !== gl.NO_ERROR) {}
                gl.readPixels(0, 0, app.width, app.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                const readError = gl.getError();
                let inside = 0, outside = 0;
                for (let y = 0; y < app.height; y++) for (let x = 0; x < app.width; x++) {
                    const offset = ((app.height - 1 - y) * app.width + x) * 4;
                    if (!(pixels[offset] || pixels[offset + 1] || pixels[offset + 2])) continue;
                    if (x >= viewport.x && x < viewport.x + viewport.width &&
                        y >= viewport.y && y < viewport.y + viewport.height) inside++;
                    else outside++;
                }
                return { viewport, readError, inside, outside };
            } finally {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
            }
        }
        app.blitFramebuffer = function (...args) {
            const resolvesScene = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) ===
                renderer.textureFramebuffer.framebuffer;
            const scissorAtBlit = gl.isEnabled(gl.SCISSOR_TEST);
            const result = original.apply(this, args);
            if (!resolvesScene) return result;
            app.blitFramebuffer = original;
            try {
                scene = { ...readPixels(renderer.textureFramebuffer.framebuffer), scissorAtBlit };
            } catch (error) {
                restore();
                reject(error);
            }
            return result;
        };
        widgets.draw = function (phase) {
            if (phase !== "postPresent" || !scene) return originalWidgetsDraw.call(this, phase);
            restore();
            try {
                const viewport = scene.viewport;
                resolve({ ...scene, root: client.widgetManager.rootInterface, dpr: devicePixelRatio,
                    metrics: renderer.computeUiRenderMetrics(app.width, app.height),
                    canvasWidth: app.width, canvasHeight: app.height,
                    cssWidth: renderer.canvas.getBoundingClientRect().width,
                    viewportBlockedByUI: renderer.isMouseInUIRegion(
                        viewport.x + viewport.width - 16, viewport.y + viewport.height - 16),
                    overlays: readPixels(null), scissorAtWidgets: gl.isEnabled(gl.SCISSOR_TEST) });
            } catch (error) {
                reject(error);
            }
            return originalWidgetsDraw.call(this, phase);
        };
    });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
