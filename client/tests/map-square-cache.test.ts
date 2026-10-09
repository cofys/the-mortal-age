import assert from "node:assert/strict";
import { cacheKey, cachePrefix, isCacheable, shouldStore } from "../game/worker/MapSquareCache";

const info: any = { game: "oldschool", environment: "live", name: "c1", revision: 230, timestamp: "t", size: 5 };
const input: any = {
    persistentCache: true, mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: true,
    smoothTerrain: true, minimizeDrawCalls: false, loadedTextureIds: new Set([1]),
};

assert.equal(cacheKey(info, input, "a"), cacheKey(info, { ...input, mapProfileEnabled: true, loadedTextureIds: new Set() }, "a"));
assert.notEqual(cacheKey(info, input, "a"), cacheKey(info, { ...input, mapX: 51 }, "a"));
assert.notEqual(cacheKey(info, input, "a"), cacheKey(info, { ...input, smoothTerrain: false }, "a"));
assert.notEqual(cacheKey(info, input, "a"), cacheKey(info, input, "b"));
assert.notEqual(cacheKey(info, input, "a"), cacheKey({ ...info, revision: 231 }, input, "a"));
assert.notEqual(cachePrefix(cacheKey(info, input, "a")), cachePrefix(cacheKey({ ...info, revision: 231 }, input, "a")));

assert.ok(isCacheable(input));
assert.ok(!isCacheable({ ...input, persistentCache: false }));
assert.ok(!isCacheable({ ...input, doorOnly: true }));
assert.ok(!isCacheable({ ...input, locOverrides: new Map([["k", {}]]) }));
assert.ok(!isCacheable({ ...input, extraLocs: [{}] }));

assert.ok(shouldStore(true, {}));
assert.ok(!shouldStore(false, {}));
assert.ok(!shouldStore(true, undefined));
console.log("map-square-cache ok");
