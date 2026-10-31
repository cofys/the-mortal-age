import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const scenario = process.argv[2];
const mobile = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const cases = {
    "iphone-chrome": [mobile + " CriOS/130.0.0.0 Mobile/15E148 Safari/604.1", 5, false],
    "iphone-firefox": [mobile + " FxiOS/130.0 Mobile/15E148 Safari/605.1.15", 5, false],
    "iphone-edge": [mobile + " EdgiOS/130.0 Mobile/15E148 Safari/605.1.15", 5, false],
    "iphone-safari": [mobile + " Version/18.0 Mobile/15E148 Safari/604.1", 5, false],
    "ipad-desktop-chrome": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 CriOS/130.0 Safari/605.1.15", 5, false],
    "mac-safari": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0, false],
    "desktop-chrome": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", 0, true],
    "android-chrome": ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36", 5, true],
} as const;

async function main(): Promise<void> {
    if (!scenario) {
        for (const name of Object.keys(cases)) {
            const result = spawnSync(process.execPath, ["--import", "tsx", process.argv[1], name], { encoding: "utf8" });
            assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
        }
        console.log("Cache browser policy: 8 browser profiles passed");
        return;
    }
    const [userAgent, maxTouchPoints, expectedShared] = cases[scenario as keyof typeof cases];
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent, maxTouchPoints } });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
    const { canUseSharedArrayBuffer, loadCacheFiles } = await import("../game/Caches");
    const { CacheFiles } = await import("../rs/cache/CacheFiles");
    assert.equal(canUseSharedArrayBuffer(), expectedShared);
    let called = false;
    CacheFiles.fetchDat2 = async (...args) => {
        called = true;
        assert.equal(args[3], expectedShared, "cache allocation policy");
        assert.equal(args[7], !expectedShared, "WebKit must keep resumable parts instead of persisting the giant dat2");
        return new CacheFiles(new Map());
    };
    globalThis.fetch = async () => new Response("[]");
    await loadCacheFiles({ name: "test", game: "oldschool", environment: "live", revision: 237, timestamp: "", size: 0 });
    assert.ok(called);
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: false });
    assert.equal(canUseSharedArrayBuffer(), false, "non-isolated contexts must never share");
}

void main();
