// WebGPU renderer smoke test. Launches its own headless Chrome (fresh --user-data-dir,
// so it never touches an already-running Chrome), navigates to the dev client with
// ?renderer=webgpu, waits for window.__WEBGPU_RENDERER__ to create a device and submit
// frames, then writes client/tests/artifacts/webgpu-smoke.png.
//
// Run: node client/tests/webgpu-smoke.browser.cjs
//
// Env:
//   CLIENT_URL        client to test (default http://localhost:3101, this worktree's port).
//                     May include query params, e.g. ?username=a&password=a (auto-login)
//   SMOKE_TIMEOUT_MS  how long to wait for the renderer (default 60000)
//   SMOKE_EXPECT_WORLD=1  also wait for the game to be logged in with visible maps
//   SMOKE_RENDERER    renderer param to force (default webgpu; "none" leaves ?renderer off,
//                     e.g. SMOKE_RENDERER=webgl to verify the fallback)
//   SMOKE_HEADLESS=0  run non-headless with a visible 1280x800 window, the fallback if
//                     headless Chrome cannot get a WebGPU adapter on this machine
//
// Chrome flags (adapter + dev client verified on Chrome 154 / macOS, headless, muted):
//   --headless=new --mute-audio --enable-unsafe-webgpu --use-angle=metal
//   --enable-features=Vulkan --disable-vulkan-surface
//   --remote-debugging-port=<free port> --user-data-dir=<temp profile>
//   --no-first-run --no-default-browser-check about:blank
// `--headless=new --enable-unsafe-webgpu` alone also got an adapter here; the ANGLE and
// Vulkan flags are kept because they are the known-good set for GPU presentation.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:3101";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60000;
const COMMAND_TIMEOUT_MS = Math.min(TIMEOUT_MS, 15000);
const DEVTOOLS_TIMEOUT_MS = Math.min(TIMEOUT_MS, 20000);
const SETTLE_MS = 3000;

const targetUrl = new URL(CLIENT_URL);
const rendererParam = process.env.SMOKE_RENDERER ?? "webgpu";
if (rendererParam !== "none") targetUrl.searchParams.set("renderer", rendererParam);

async function main() {
    assert.ok(fs.existsSync(CHROME_PATH), `Chrome not found at ${CHROME_PATH}`);
    const failures = [];
    const consoleMessages = [];
    const debugPort = await freePort();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "webgpu-smoke-"));
    const chrome = spawn(CHROME_PATH, chromeFlags(debugPort, profileDir), {
        stdio: "ignore",
        detached: true,
    });
    let socket;
    try {
        const tab = await waitForDevtoolsPage(debugPort);
        socket = new WebSocket(tab.webSocketDebuggerUrl);
        const cdp = createCdp(socket, consoleMessages);
        await cdp.opened;
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Page.enable");

        console.log(`[webgpu-smoke] navigating to ${targetUrl.href}`);
        await cdp.send("Page.navigate", { url: targetUrl.href });

        const deadline = Date.now() + TIMEOUT_MS;
        let state = { present: false };
        while (!rendererReady(state, rendererParam) && Date.now() < deadline) {
            await sleep(250);
            try {
                state = await rendererState(cdp);
            } catch {
                // The execution context is replaced during navigation; keep polling.
            }
        }
        if (!rendererReady(state, rendererParam)) {
            failures.push(
                `renderer (${rendererParam}) did not appear within ${TIMEOUT_MS}ms`,
            );
        } else {
            await sleep(SETTLE_MS);
            state = await rendererState(cdp);
            console.log(`[webgpu-smoke] renderer state: ${JSON.stringify(state)}`);
            if (process.env.SMOKE_ENABLE_HD === "1") {
                const result = await cdp.send("Runtime.evaluate", {
                    returnByValue: true,
                    expression: `(() => {
                        const client =
                            window.osrsClient ??
                            (window.__WEBGPU_RENDERER__ && window.__WEBGPU_RENDERER__.osrsClient) ??
                            null;
                        if (!client || !client.hdPlugin) return "hd-plugin-missing";
                        client.hdPlugin.setEnabledState(true);
                        return "hd-enabled";
                    })()`,
                });
                console.log(`[webgpu-smoke] HD enable: ${result.result?.value}`);
                if (result.result?.value !== "hd-enabled") {
                    failures.push(`HD enable failed: ${result.result?.value}`);
                }
            }
            if (!state.running) failures.push("renderer.running is false");
            if (!(state.frameCount > 0)) {
                failures.push(`renderer submitted no frames (frameCount=${state.frameCount})`);
            }
            if (!(state.canvasWidth > 0 && state.canvasHeight > 0)) {
                failures.push(`canvas is ${state.canvasWidth}x${state.canvasHeight}`);
            }
            if (process.env.SMOKE_EXPECT_WORLD === "1") {
                while (!(state.visibleMaps > 0) && Date.now() < deadline) {
                    await sleep(500);
                    state = await rendererState(cdp);
                }
                await sleep(Number(process.env.SMOKE_FINAL_WAIT_MS) || 2000);
                state = await rendererState(cdp);
                console.log(`[webgpu-smoke] world state: ${JSON.stringify(state)}`);
                if (!state.loggedIn) failures.push("client is not in a logged-in state");
                if (!(state.visibleMaps > 0)) {
                    failures.push(`no visible maps (visibleMaps=${state.visibleMaps})`);
                }
                if (process.env.SMOKE_EXPECT_HD === "1" && !state.hdEnabled) {
                    failures.push("HD plugin is not enabled");
                }
            }
            const baselineWait = Number(process.env.SMOKE_BASELINE_WAIT_MS) || 0;
            if (baselineWait > 0) {
                const start = await controlledPlayerTile(cdp);
                await sleep(baselineWait);
                const end = await controlledPlayerTile(cdp);
                console.log(
                    `[webgpu-smoke] baseline tile ${JSON.stringify(start)} -> ${JSON.stringify(end)}`,
                );
                if (start && end && start.x === end.x && start.y === end.y) {
                    console.log("[webgpu-smoke] baseline: player stationary before click");
                } else {
                    failures.push(
                        `player moved without a click (${JSON.stringify(start)} -> ${JSON.stringify(end)})`,
                    );
                }
            }
            const clickAt = process.env.SMOKE_CLICK_AT;
            if (clickAt && process.env.SMOKE_EXPECT_HOVER === "1") {
                const [cx, cy] = clickAt.split(",").map(Number);
                await cdp.send("Runtime.evaluate", {
                    expression: "if (window.osrsClient) window.osrsClient.hoverOverlayEnabled = true;",
                });
                await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });
                await sleep(Number(process.env.SMOKE_CLICK_WAIT_MS) || 1000);
                const hover = await evaluateHover(cdp);
                console.log(`[webgpu-smoke] hover state: ${JSON.stringify(hover)}`);
                if (!hover || !hover.tile) {
                    failures.push(`hover tile not populated: ${JSON.stringify(hover)}`);
                }
            }
            if (clickAt) {
                const [cx, cy] = clickAt.split(",").map(Number);
                const expectMenu = process.env.SMOKE_EXPECT_MENU === "1";
                const expectMove = process.env.SMOKE_EXPECT_MOVE === "1";
                const button = expectMenu ? "right" : "left";
                if (expectMenu) {
                    // ?mobile=1 (used to skip the welcome screen) also flips the desktop
                    // tooltips default off, which makes the shared world-menu pass close the
                    // menu on the next frame. Force the desktop default for this check.
                    await cdp.send("Runtime.evaluate", {
                        expression: "if (window.osrsClient) window.osrsClient.tooltips = true;",
                    });
                }
                const before = expectMove ? await controlledPlayerTile(cdp) : null;
                console.log(`[webgpu-smoke] clicking (${cx}, ${cy}) button=${button}`);
                for (const type of ["mousePressed", "mouseReleased"]) {
                    await cdp.send("Input.dispatchMouseEvent", {
                        type,
                        x: cx,
                        y: cy,
                        button,
                        clickCount: 1,
                    });
                }
                await sleep(Number(process.env.SMOKE_CLICK_WAIT_MS) || 3000);
                state = await rendererState(cdp);
                console.log(`[webgpu-smoke] post-click state: ${JSON.stringify(state)}`);
                if (before) {
                    const after = await controlledPlayerTile(cdp);
                    console.log(
                        `[webgpu-smoke] player tile ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
                    );
                    if (!after || (after.x === before.x && after.y === before.y)) {
                        failures.push(
                            `player did not move after click (${JSON.stringify(before)})`,
                        );
                    }
                }
                if (expectMenu) {
                    const menu = await worldMenuState(cdp);
                    console.log(`[webgpu-smoke] world menu: ${JSON.stringify(menu)}`);
                    const options = menu.options || [];
                    const hasWorldEntry = options.some((option) => !/^cancel$/i.test(option));
                    if (!menu.open || options.length === 0) {
                        failures.push(`world menu did not open: ${JSON.stringify(menu)}`);
                    } else if (!hasWorldEntry) {
                        failures.push(
                            `world menu has only Cancel: ${JSON.stringify(options)}`,
                        );
                    }
                }
            }
        }
        await captureScreenshot(cdp);
    } catch (error) {
        failures.push(`smoke run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        try {
            socket?.close();
        } catch {}
        killChrome(chrome);
        removeDir(profileDir);
    }
    failures.push(...scanConsole(consoleMessages));

    const errors = consoleMessages.filter((message) => message.level === "error");
    if (errors.length > 0) {
        console.error(`[webgpu-smoke] console errors (${errors.length}):`);
        for (const { text } of errors) console.error(`  ${text}`);
    }
    if (failures.length > 0) {
        console.error(`FAIL WebGPU smoke test: ${failures.join("; ")}`);
        process.exitCode = 1;
    } else {
        console.log("PASS WebGPU smoke test: renderer running and submitting frames");
    }
}

function chromeFlags(debugPort, profileDir) {
    const headless = process.env.SMOKE_HEADLESS !== "0";
    return [
        ...(headless ? ["--headless=new"] : ["--window-size=1280,800"]),
        "--mute-audio",
        "--enable-unsafe-webgpu",
        "--use-angle=metal",
        "--enable-features=Vulkan",
        "--disable-vulkan-surface",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ];
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForDevtoolsPage(port) {
    const deadline = Date.now() + DEVTOOLS_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
                signal: AbortSignal.timeout(2000),
            });
            const tab = (await response.json()).find(
                (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
            );
            if (tab) return tab;
        } catch (error) {
            lastError = error;
        }
        await sleep(250);
    }
    throw new Error(`DevTools endpoint never came up on port ${port}: ${lastError}`);
}

function createCdp(socket, consoleMessages) {
    const pending = new Map();
    let nextId = 0;
    socket.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.id !== undefined && pending.has(message.id)) {
            const { resolve, reject, timer } = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(timer);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
            return;
        }
        collectConsoleMessage(message, consoleMessages);
    });
    socket.on("error", (error) => {
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        pending.clear();
    });
    const opened = new Promise((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) resolve();
        else {
            socket.once("open", resolve);
            socket.once("error", reject);
        }
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
            }, COMMAND_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });
    return { send, opened };
}

function collectConsoleMessage(message, consoleMessages) {
    if (message.method === "Runtime.consoleAPICalled") {
        consoleMessages.push({
            level: message.params.type,
            text: message.params.args.map(describeConsoleArg).join(" "),
        });
    } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        consoleMessages.push({
            level: "error",
            text: details.exception?.description ?? details.text,
        });
    } else if (message.method === "Log.entryAdded") {
        consoleMessages.push({
            level: message.params.entry.level,
            text: message.params.entry.text,
        });
    }
}

function describeConsoleArg(arg) {
    if (arg.value !== undefined) {
        return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
    }
    return arg.description ?? arg.unserializableValue ?? arg.type;
}

async function rendererState(cdp) {
    const response = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
            const renderer =
                window.__WEBGPU_RENDERER__ ??
                (window.osrsClient && window.osrsClient.renderer) ??
                null;
            if (!renderer) return { present: false };
            const canvas = renderer.canvas;
            return {
                present: true,
                rendererType: renderer.type ?? (renderer.device ? "webgpu" : "webgl"),
                hasDevice: !!renderer.device,
                running: renderer.running === true,
                frameCount: Number(renderer.stats && renderer.stats.frameCount) || 0,
                canvasWidth: canvas ? canvas.width : 0,
                canvasHeight: canvas ? canvas.height : 0,
                loggedIn:
                    !!(renderer.osrsClient && renderer.osrsClient.isLoggedIn
                        ? renderer.osrsClient.isLoggedIn()
                        : false),
                gameState: renderer.osrsClient ? renderer.osrsClient.gameState : -1,
                hdEnabled: !!(renderer.osrsClient && renderer.osrsClient.hdPlugin &&
                    renderer.osrsClient.hdPlugin.isEnabled && renderer.osrsClient.hdPlugin.isEnabled()),
                visibleMaps:
                    renderer.mapManager && renderer.mapManager.visibleMaps
                        ? renderer.mapManager.visibleMaps.length
                        : 0,
                atlasTextures: (() => {
                    try {
                        return renderer.world ? renderer.world.loadedTextureIds.size : -1;
                    } catch {
                        return -1;
                    }
                })(),
                loadingPending: (() => {
                    try {
                        const tracker = renderer.osrsClient.loadingTracker;
                        return Array.from(tracker.requirements).filter(
                            (requirement) => !tracker.completed.has(requirement),
                        );
                    } catch {
                        return [];
                    }
                })(),
            };
        })()`,
    });
    return response.result?.value ?? { present: false };
}

function rendererReady(state, expected) {
    if (!state.present) return false;
    if (expected === "webgpu") return state.hasDevice === true;
    if (expected === "webgl") return state.rendererType === "webgl";
    return true;
}

/** Sub-tile X/Y of the controlled player, for SMOKE_EXPECT_MOVE runs. */
async function controlledPlayerTile(cdp) {
    const response = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
            const client =
                window.osrsClient ??
                (window.__WEBGPU_RENDERER__ && window.__WEBGPU_RENDERER__.osrsClient) ??
                null;
            if (!client) return null;
            const pe = client.playerEcs;
            const idx = pe.getIndexForServerId(client.controlledPlayerServerId | 0);
            if (idx === undefined) return null;
            return { x: pe.getX(idx) | 0, y: pe.getY(idx) | 0, serverId: client.controlledPlayerServerId | 0 };
        })()`,
    });
    return response.result?.value ?? null;
}

/** Hovered world tile, for SMOKE_EXPECT_HOVER runs. */
async function evaluateHover(cdp) {
    const response = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
            const client =
                window.osrsClient ??
                (window.__WEBGPU_RENDERER__ && window.__WEBGPU_RENDERER__.osrsClient) ??
                null;
            if (!client) return null;
            const canvas = document.querySelector("canvas");
            const rect = canvas ? canvas.getBoundingClientRect() : null;
            const px = client.inputManager.mouseX === -1 ? 300 : client.inputManager.mouseX;
            const py = client.inputManager.mouseY === -1 ? 200 : client.inputManager.mouseY;
            const stack = (document.elementsFromPoint(px, py) || []).slice(0, 4).map((el) => {
                return (
                    el.tagName +
                    "|" +
                    String(el.className || "").slice(0, 40) +
                    "|" +
                    String((el.style && el.style.pointerEvents) || "")
                );
            });
            const hud = document.querySelector(".hud.left-bottom");
            return {
                enabled: !!client.hoverOverlayEnabled,
                mouse: [client.inputManager.mouseX, client.inputManager.mouseY],
                stack,
                hudPointerEvents: hud ? getComputedStyle(hud).pointerEvents : null,
                rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
                contains:
                    client.camera && client.camera.containsScreenPoint
                        ? client.camera.containsScreenPoint(px, py)
                        : null,
                tile: client.hoveredTile ?? null,
                screen: client.hoveredTileScreen ?? null,
            };
        })()`,
    });
    return response.result?.value ?? null;
}

/** Open world menu entries, for SMOKE_EXPECT_MENU runs. */
async function worldMenuState(cdp) {    const response = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
            const client =
                window.osrsClient ??
                (window.__WEBGPU_RENDERER__ && window.__WEBGPU_RENDERER__.osrsClient) ??
                null;
            if (!client) return { open: false, options: [] };
            return {
                open: !!client.menuOpen,
                options: (client.menuEntries || []).map((entry) => String(entry.option || "")),
            };
        })()`,
    });
    return response.result?.value ?? { open: false, options: [] };
}

function scanConsole(consoleMessages) {
    const failures = [];
    for (const { level, text } of consoleMessages) {
        if (!text) continue;
        if (level === "error" && /\[webgpu\]/i.test(text)) {
            failures.push(`console error: ${text}`);
        } else if (/Validation Error|device lost/i.test(text)) {
            failures.push(`WebGPU error text: ${text}`);
        }
    }
    return failures;
}

async function captureScreenshot(cdp) {
    const artifactsDir = path.join(__dirname, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const name = process.env.SMOKE_SCREENSHOT || "webgpu-smoke.png";
    const file = path.join(artifactsDir, name);
    try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        console.log(`[webgpu-smoke] screenshot: ${file}`);
    } catch (error) {
        console.error(`[webgpu-smoke] screenshot failed: ${error.message}`);
    }
}

function killChrome(chrome) {
    try {
        process.kill(-chrome.pid, "SIGKILL");
    } catch {
        try {
            chrome.kill("SIGKILL");
        } catch {}
    }
}

function removeDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
