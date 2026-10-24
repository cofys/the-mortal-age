import assert from "node:assert/strict";
import { HdClutterLayer, grassBladesForTile, grassDensity } from "../game/plugins/hd/webgpu/hd-clutter";
import { HdGroundMaterial } from "../game/plugins/hd/HdGroundMaterials";

assert.equal(grassDensity(0), 1, "grass is full density beside the player");
assert.ok(Math.abs(grassDensity(40) - 0.2) < 1e-9, "the far field thins to a fifth");
assert.equal(grassBladesForTile(0), 24);
assert.equal(grassBladesForTile(60), 0, "nothing is stored past the band plus the bucket");

// The set is rebuilt per 8-tile bucket: whatever the shader shows anywhere in the bucket must be stored.
const reach = 8 * Math.SQRT2;
for (let distance = 0; distance <= 48; distance += 0.25) {
    for (let moved = 0; moved <= reach; moved += 0.5) {
        const shownAt = Math.max(0, distance - moved);
        const shown = shownAt < 36 ? Math.ceil(24 * grassDensity(shownAt) - 0.5) : 0;
        assert.ok(grassBladesForTile(distance) >= shown, `tile at ${distance} keeps blades for a player ${moved} tiles closer`);
    }
}

// MapManager sorts the same visible squares by the orbiting camera, not the player.
let uploads = 0, builds = 0, plane = 0;
const device = {
    createBindGroupLayout: () => ({}), createBindGroup: () => ({}), createShaderModule: () => ({}),
    createPipelineLayout: () => ({}), createRenderPipeline: () => ({}),
    createBuffer: (descriptor: any) => ({ ...descriptor, destroy() {} }),
    queue: { writeBuffer(buffer: any) { if (buffer.label === "hd-clutter vertices") uploads++; } },
};
const map = (id: number, x: number) => ({
    id, tileGroundMaterials: [[new Uint8Array([HdGroundMaterial.GRASS])]],
    tileGroundColors: [[new Uint32Array([0x224411])]], heightMapData: new Int16Array([0]),
    locDataChangedListeners: new Set<() => void>(),
    getRenderBaseTileX: () => x, getRenderBaseTileY: () => 3508, getLocalTileSpan: () => 1,
    getGroundMaterial: () => HdGroundMaterial.GRASS,
    getGroundColor() { return this.tileGroundColors[0][0][0]; },
    sampleHeightAtExactPlane() { return this.heightMapData[0]; },
});
const first = map(1, 3104), second = map(2, 3105);
const renderer = { world: { extension: { sceneColorFormat: "rgba16float" }, sceneUniformsLayout: {}, sceneBindGroup: {} },
    playerPosUni: [3104, 3508], getPlayerRawPlane: () => plane,
    mapManager: { visibleMaps: [first, second] } } as any;
const layer = new HdClutterLayer(device as any);
const build = (layer as any).build;
(layer as any).build = (...args: any[]) => { builds++; return build.apply(layer, args); };
layer.update(renderer);
const initial = (layer as any).vertices.slice(0, (layer as any).floats);
for (let frame = 0; frame < 60; frame++) {
    renderer.mapManager.visibleMaps.reverse();
    layer.update(renderer);
}
assert.equal(builds, 1, "reordering resident squares during a camera pan must not rebake grass");
assert.equal(uploads, 1, "camera-only order changes must not upload the grass mesh again");
assert.deepEqual((layer as any).vertices.subarray(0, (layer as any).floats), initial);

renderer.playerPosUni[0] += 1;
layer.update(renderer);
assert.equal(builds, 1, "movement within the cached bucket retains the same grass set");
renderer.playerPosUni[0] += 8;
layer.update(renderer);
assert.equal(builds, 2, "crossing a player bucket still rebuilds the full grass band");
plane = 1;
layer.update(renderer);
assert.equal(builds, 3, "a floor transition still changes the grass set");

const replacement = { ...first, locDataChangedListeners: new Set<() => void>() };
renderer.mapManager.visibleMaps = [replacement, second];
layer.update(renderer);
assert.equal(builds, 4, "a same-ID replacement must not inherit old grass");
assert.equal(first.locDataChangedListeners.size, 0);
replacement.tileGroundColors = [[new Uint32Array([0x884411])]];
layer.update(renderer);
assert.equal(builds, 5, "same-ID ground metadata replacement invalidates the mesh");
replacement.heightMapData[0] = 7;
for (const listener of replacement.locDataChangedListeners) listener();
layer.update(renderer);
assert.equal(builds, 6, "in-place partial map refreshes invalidate through the map's data event");
let roots = 0;
for (let i = 0; i < (layer as any).floats; i += 12) {
    if ((layer as any).vertices[i] >= 3105) continue;
    assert.equal((layer as any).vertices[i + 1], 7, "the new grass roots use the replaced height data");
    roots++;
}
assert.ok(roots > 0);
renderer.mapManager.visibleMaps = [replacement];
layer.update(renderer);
assert.equal(builds, 7, "removing a visible square removes its blades");
assert.equal(second.locDataChangedListeners.size, 0);
const added = map(3, 3106);
renderer.mapManager.visibleMaps.push(added);
layer.update(renderer);
assert.equal(builds, 8, "adding a resident square still adds its grass");
layer.dispose();
assert.equal(replacement.locDataChangedListeners.size, 0, "disposal releases map subscriptions");
assert.equal(added.locDataChangedListeners.size, 0);
console.log("hd grass ok");
