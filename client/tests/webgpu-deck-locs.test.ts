import "./browser-self";
import { strict as assert } from "node:assert";

import { LocUpdates } from "../render/webgpu/locUpdates";

// WebGPU: a loc added, changed or animated on a boat deck rebuilds that boat's scene, as WebGL
// does. It used to reload a main-world map square under the deck's coordinates, so a salvaging
// hook never animated and a facility replaced in the shipyard showed only after re-entering.
const DECK = 7;
const rebuilds: number[] = [];
const squareReloads: number[] = [];
const seqs = new Map<number, { frameStep: number }>([[13574, { frameStep: 4 }], [13573, { frameStep: -1 }]]);
const renderer: any = {
    addedLocs: new Map(),
    locOverrides: new Map(),
    worldEntityOverlays: new Map([[DECK, {}]]),
    instanceActive: false,
    scheduleWorldEntityLocRebuild: (entity: number) => rebuilds.push(entity),
    queueLocReload: (x: number, y: number) => squareReloads.push((x << 8) | y),
    mapManager: { getMap: () => ({}), loadingMapIds: new Set() },
    osrsClient: {
        worldViewManager: { findWorldViewAt: (x: number) => (x >= 9600 ? { id: DECK } : undefined) },
        locTypeLoader: { load: () => ({}) },
        seqTypeLoader: { load: (id: number) => seqs.get(id) },
    },
};
const updates = new LocUpdates(renderer);
const hook = { x: 9603, y: 9602 };

updates.onLocAddChange(60494, hook, 1, 10, 1);
assert.deepEqual(rebuilds, [DECK], "a replaced facility rebuilds the deck");

updates.onLocAnim(60494, hook, 1, 10, 1, 13573);
assert.deepEqual(rebuilds, [DECK, DECK], "the hook's drop animation rebuilds it with the animation");
assert.equal(renderer.locOverrides.get("9603,9602,1,60494")?.seqId, 13573);

updates.onLocAnim(60494, hook, 1, 10, 1, 13574);
updates.onLocAnim(60494, hook, 1, 10, 1, 13574);
assert.equal(rebuilds.length, 3, "the idle rebuilds once; sent again while it loops it only extends it");

updates.onLocAddChange(1276, { x: 3200, y: 3200 }, 0, 10, 0);
assert.equal(rebuilds.length, 3, "a main-world loc doesn't touch the deck");
setTimeout(() => {
    assert.deepEqual(squareReloads, [(50 << 8) | 50], "only the main-world loc reloaded a map square");
    updates.dispose();
    console.log("webgpu-deck-locs: ok");
}, 100);
