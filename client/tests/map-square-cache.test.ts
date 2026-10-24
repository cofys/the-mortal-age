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

assert.notEqual(cacheKey(info, { ...input, smoothLocAnimations: true, smoothLocAnimationSteps: 4 }, "a"),
    cacheKey(info, { ...input, smoothLocAnimations: true, smoothLocAnimationSteps: 8 }, "a"));
assert.ok(isCacheable(input));
assert.ok(!isCacheable({ ...input, persistentCache: false }));
assert.ok(!isCacheable({ ...input, doorOnly: true }));
assert.ok(!isCacheable({ ...input, locOnly: true }));
assert.ok(!isCacheable({ ...input, minimapOnly: true }));
assert.ok(!isCacheable({ ...input, instance: {} }));
assert.ok(!isCacheable({ ...input, overrideRenderPos: { x: 0, y: 0 } }));
assert.ok(!isCacheable({ ...input, locOverrides: new Map([["k", {}]]) }));
assert.ok(!isCacheable({ ...input, locSpawns: new Map([["k", {}]]) }));
assert.ok(!isCacheable({ ...input, terrainOverrides: new Map([["k", {}]]) }));
assert.ok(!isCacheable({ ...input, mapRegionReplacements: new Map([["k", {}]]) }));
assert.ok(!isCacheable({ ...input, extraLocs: [{}] }));
assert.ok(!isCacheable({ ...input, extraNpcs: [{}] }));

const withOverride = (key: string, value: any = { newId: 1 }) => ({
    ...input, locOverrides: new Map([[key, value]]),
});
assert.ok(isCacheable(withOverride("1000,1000,0,1")), "unrelated global loc changes must not disable this square's cache");
assert.equal(cacheKey(info, withOverride("1000,1000,0,1"), "a"), cacheKey(info, input, "a"));
for (const [x, y] of [[3200, 3200], [3194, 3194], [3269, 3269], [3194, 3232], [3232, 3269]]) {
    assert.ok(!isCacheable(withOverride(`${x},${y},3,1`)), "the complete six-tile source border can affect geometry, lighting and metadata");
}
for (const [x, y] of [[3193, 3232], [3270, 3232], [3232, 3193], [3232, 3270]]) {
    assert.ok(isCacheable(withOverride(`${x},${y},0,1`)), "loc origins outside the loader's source scene are clipped before model placement");
}
assert.ok(!isCacheable(withOverride("1000,1000,0,1", { newId: 1, moveToX: 3201, moveToY: 3201 })), "a moved loc entering the scene stays uncached");
assert.ok(!isCacheable(withOverride("3201,3201,0,1", { newId: 1, moveToX: 1000, moveToY: 1000 })), "a moved loc leaving the scene still changes its source");
assert.ok(isCacheable(withOverride("1000,1000,0,1", { newId: 1, moveToX: 1010, moveToY: 1010 })));
assert.ok(!isCacheable(withOverride("1000,1000,0,1", { newId: 1, moveToX: NaN, moveToY: 1010 })), "unknown coordinates must fail closed");
assert.ok(isCacheable({ ...input, locSpawns: new Map([["1000,1000,0,extra", {}]]) }));
assert.ok(!isCacheable({ ...input, locSpawns: new Map([["3194,3200,0,extra", {}]]) }));
assert.ok(isCacheable({ ...input, terrainOverrides: new Map([["1000,1000,0", {}]]) }));
assert.ok(!isCacheable({ ...input, terrainOverrides: new Map([["3269,3200,0", {}]]) }));
assert.ok(isCacheable({ ...input, mapRegionReplacements: new Map([[(48 << 8) | 50, {}]]) }));
assert.ok(!isCacheable({ ...input, mapRegionReplacements: new Map([[(49 << 8) | 49, {}]]) }), "a replacement in a neighbouring source region may change the border");
assert.ok(!isCacheable({ ...input, mapRegionReplacements: new Map([[(51 << 8) | 51, {}]]) }));

assert.ok(shouldStore(true, {}));
assert.ok(!shouldStore(false, {}));
assert.ok(!shouldStore(true, undefined));
console.log("map-square-cache ok");
