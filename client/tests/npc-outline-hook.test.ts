import { strict as assert } from "node:assert";
import { getInteractHighlightDrawTargets } from "../render/render/interact/highlight";

// Plugin NPC outlines go through the shared resolver both renderers use, even with Interact
// Highlight switched off; width becomes the per-target outline radius.
const built: unknown[] = [];
const host: any = {
    interactHighlightDrawTargets: [],
    osrsClient: {
        clientPlugins: {
            npcOutlines: () => [{ ecsId: 3, serverId: 30, color: 0x00ffff, alpha: 1, width: 4 }],
            interactHighlightConfig: () => undefined,
        },
        npcEcs: { getNpcTypeId: () => 655, getLevel: () => 0, getWorldViewId: () => -1 },
    },
    buildNpcModelHighlightTriangles: (target: unknown) => {
        built.push(target);
        return [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    },
};
const targets = getInteractHighlightDrawTargets(host);
assert.equal(targets.length, 1);
assert.deepEqual(built, [{ kind: "npc", ecsId: 3, serverId: 30, npcTypeId: 655, plane: 0 }]);
assert.equal(targets[0].color, 0x00ffff);
assert.equal(targets[0].alpha, 1);
assert.equal(targets[0].outlineRadius, 3.8);
host.osrsClient.clientPlugins.npcOutlines = () => [];
assert.equal(getInteractHighlightDrawTargets(host).length, 0, "Interact Highlight off and no plugin outlines");
console.log("npc outline hook tests passed");
