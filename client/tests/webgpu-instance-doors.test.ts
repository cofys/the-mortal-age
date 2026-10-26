import "./browser-self";
import assert from "node:assert/strict";
import { test } from "node:test";

import { LocUpdates } from "../render/webgpu/locUpdates";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

function fixture() {
    const reloads: string[] = [];
    let rebuilds = 0;
    const door = { id: 13016, name: "Door", actions: ["Open"], seqId: -1 };
    const renderer: any = {
        instanceActive: true,
        instanceSceneMap: { mapX: 100, mapY: 100 },
        instances: { hasPendingWork: () => false },
        addedLocs: new Map(), locOverrides: new Map(), locSpawns: new Map(),
        mapManager: {
            getMap: (mapX: number, mapY: number) => (mapX === 100 && mapY === 100 ? {} : undefined),
            getMapForWorldTile: () => undefined,
            loadingMapIds: new Set<number>(),
        },
        osrsClient: { locTypeLoader: { load: () => door } },
        queueLocReload: (mapX: number, mapY: number, group: string) => reloads.push(`${mapX},${mapY},${group}`),
        scheduleInstanceLocRebuild: () => rebuilds++,
    };
    return { renderer, reloads, rebuilds: () => rebuilds, updates: new LocUpdates(renderer) };
}

test("a house door in a drawn instance rebuilds only the scene's door geometry", async () => {
    const { reloads, rebuilds, updates } = fixture();
    // Both leaves swing open: each is a LOC_ADD_CHANGE at its open tile.
    updates.onLocAddChange(13018, { x: 6438, y: 6443 }, 1, 0, 3);
    updates.onLocAddChange(13017, { x: 6438, y: 6444 }, 1, 0, 1);
    await flush();
    assert.deepEqual(reloads, ["100,100,door"], "the doors of the scene's one square, in one batch");
    assert.equal(rebuilds(), 0);
});

test("instance loc changes rebuild the scene while one is still building", async () => {
    const { renderer, reloads, rebuilds, updates } = fixture();
    renderer.instances.hasPendingWork = () => true;
    updates.onLocAddChange(13018, { x: 6438, y: 6443 }, 1, 0, 3);
    await flush();
    assert.deepEqual(reloads, []);
    assert.equal(rebuilds(), 1, "the scene being built is replaced by one with the change");
});
