import assert from "node:assert/strict";
import { HdLights, collectHdLights } from "../game/plugins/hd/HdLights";
import { HdSceneInputs } from "../game/plugins/hd/HdSceneInputs";

let offsetReads = 0, locLoads = 0, heightSamples = 0;
function square(variant: number) {
    const offsets = new Uint32Array(4097), ids: number[] = [];
    for (let tile = 0; tile < 4096; tile++) {
        offsets[tile] = ids.length;
        const x = tile % 64, z = Math.floor(tile / 64);
        if (x >= 12 && x <= 20 && z >= 12 && z <= 20) ids.push([196, 205, 2156, 3918, 4004][(x + z + variant) % 5]);
    }
    offsets[4096] = ids.length;
    const counted = new Proxy(offsets, { get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) offsetReads++;
        return Reflect.get(target, key, target);
    } });
    return {
        baseX: 0, baseZ: 0, span: 64, interactionPlane: -1, heightMapSize: 76, borderSize: 6,
        getRenderBaseWorldX() { return this.baseX; }, getRenderBaseWorldY() { return this.baseZ; },
        getLocalTileSpan() { return this.span; },
        heightMapData: new Int16Array([64]), locDataChangedListeners: new Set<() => void>(),
        tileLocOffsetsByLevel: [counted, counted],
        tileLocIdsByLevel: [new Int32Array(ids), new Int32Array(ids)],
        tileLocTypeRotByLevel: [new Uint8Array(ids.map((_, i) => (i % 4) << 6)), new Uint8Array(ids.length)],
    };
}

let a = square(0), b = square(1), plane = 0;
let environment = {}, options = {};
const view = { baseX: 0, baseY: 0, sizeX: 64, sizeY: 64 };
let viewId = -1;
const host = {
    playerPosUni: [16.5, 16.5], getPlayerRawPlane: () => plane,
    getControlledPlayerWorldViewId: () => viewId,
    sampleHeightAtExactPlane(x: number, z: number, level: number) {
        heightSamples++;
        return -a.heightMapData[0] / 16 - level - (x + z) / 1024;
    },
    mapManager: { mapSquares: new Map([[1, a], [2, b]]), worldEntityMapIds: new Set<number>(),
        visibleMaps: [a, b], visibleMapCount: 2 },
    osrsClient: { locTypeLoader: { load(id: number) { locLoads++; return { sizeX: 1 + id % 2, sizeY: 2 }; } },
        worldViewManager: { getWorldView: () => view } },
    instanceActive: false, instanceTemplateChunks: undefined as unknown,
};
const inputs = new HdSceneInputs(), lights = new HdLights();
const positions = new Float32Array(64), colors = new Float32Array(64);
const expectedPositions = new Float32Array(64), expectedColors = new Float32Array(64);
let time = 1000;
function compare(revision: number) {
    const count = lights.collect(host, positions, colors, time, revision);
    const saved = [offsetReads, locLoads, heightSamples];
    assert.equal(count, collectHdLights(host, expectedPositions, expectedColors, time));
    [offsetReads, locLoads, heightSamples] = saved;
    assert.deepEqual(positions, expectedPositions, "cached positions/radius match the stateless scan bit for bit");
    assert.deepEqual(colors, expectedColors, "flicker/pulse colours match the stateless scan bit for bit");
    time += 34;
}
const revision = inputs.update(host, plane, environment, options);
compare(revision);
const first = [offsetReads, locLoads, heightSamples];
assert.ok(first.every(value => value > 0));
const previousAnimation = positions.slice();
for (let frame = 1; frame < 60; frame++) {
    host.mapManager.visibleMaps.reverse();
    assert.equal(inputs.update(host, plane, environment, options), revision,
        "camera sorting is not a resident terrain/loc change");
    compare(revision);
}
assert.deepEqual([offsetReads, locLoads, heightSamples], first,
    "60 animation updates with changing map order scan the location grid only once");
assert.notDeepEqual(positions, previousAnimation, "cached static positions retain animated light radii");
assert.ok([...((lights as any).maps as Map<unknown, { candidates: unknown[] }>).values()]
    .every(entry => entry.candidates.length <= 16), "cache retains at most the shader budget per map");

function refresh(reason: string, mutate: () => void) {
    const before = inputs.update(host, plane, environment, options), reads = offsetReads;
    mutate();
    const after = inputs.update(host, plane, environment, options);
    assert.notEqual(after, before, reason);
    compare(after);
    assert.ok(offsetReads > reads, `${reason} refreshes static light locations`);
}
refresh("in-place partial reload notification", () => {
    a.tileLocIdsByLevel[0][0] = 205;
    a.heightMapData[0] = 80;
    for (const listener of a.locDataChangedListeners) listener();
});
refresh("same map's replacement height data", () => { a.heightMapData = new Int16Array([96]); });
refresh("per-plane loc arrays replaced inside unchanged outer arrays", () => {
    a.tileLocIdsByLevel[0] = a.tileLocIdsByLevel[0].slice();
    a.tileLocIdsByLevel[0][1] = 196;
});
refresh("plane changes", () => { plane = 1; });
refresh("environment changes", () => { environment = {}; });
refresh("HD configuration changes", () => { options = {}; });
refresh("instance template changes", () => { host.instanceActive = true; host.instanceTemplateChunks = [[[1]]]; });
refresh("boat deck plane", () => { a.interactionPlane = 1; });
refresh("boat/world entity membership", () => { host.mapManager.worldEntityMapIds.add(1); });
refresh("preferred world view", () => { viewId = 5; });
refresh("moving world-view bounds", () => { view.baseX = 1; });
refresh("instance/overlay render origin", () => { a.baseX = 0.5; a.span = 48; });

const old = a;
refresh("same ID replaced with a different map object", () => {
    a = square(3);
    host.mapManager.mapSquares.set(1, a);
    host.mapManager.visibleMaps = [a, b];
});
assert.equal(old.locDataChangedListeners.size, 0, "replacement releases the old map listener");
assert.equal(a.locDataChangedListeners.size, 1);
const movedReads = offsetReads;
host.playerPosUni[0] += 0.001;
compare(inputs.update(host, plane, environment, options));
assert.ok(offsetReads > movedReads, "sub-tile player movement invalidates static distance/height data");

host.mapManager.mapSquares.delete(2);
host.mapManager.visibleMaps = [a];
host.mapManager.visibleMapCount = 1;
compare(inputs.update(host, plane, environment, options));
assert.equal(b.locDataChangedListeners.size, 0, "removed maps are not retained by terrain listeners");
assert.equal((lights as any).maps.size, 1, "removed/invisible map light caches are evicted");
inputs.dispose();
lights.dispose();
assert.equal(a.locDataChangedListeners.size, 0, "renderer disposal removes all remaining listeners");
assert.equal((lights as any).maps.size, 0);
assert.equal((inputs as any).maps.size, 0);
console.log("HD scene input cache parity/invalidation passed", { firstOffsetReads: first[0], firstLocLoads: first[1],
    firstHeightSamples: first[2], cachedUpdates: 60, legacyOffsetReads: first[0] * 60 });
