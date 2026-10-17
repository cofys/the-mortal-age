import { strict as assert } from "node:assert";

import { ClientState } from "../game/ClientState";
import { MenuTargetType } from "../rs/MenuEntry";
import {
    buildItemModelHighlightTriangles,
    isItemHighlightTargetStillPresent,
    resolveItemHighlightTargetFromEntry,
} from "../render/render/interact/highlightItem";

const LOGS = 1511;
const TINDERBOX = 590;

// Logs and a tinderbox on world tile (3222, 3218), plane 0; scene base (3200, 3200).
let stacks = [
    { id: 1, itemId: TINDERBOX, quantity: 1, tile: { x: 3222, y: 3218, level: 0 } },
    { id: 2, itemId: LOGS, quantity: 1, tile: { x: 3222, y: 3218, level: 0 } },
];
const requestedModels: Array<[number, number]> = [];
const host = {
    osrsClient: {
        groundItems: {
            getStacksAt: (x: number, y: number, level: number) =>
                stacks.filter((s) => s.tile.x === x && s.tile.y === y && s.tile.level === level),
        },
        objModelLoader: {
            getModel: (id: number, count: number) => {
                requestedModels.push([id, count]);
                return { verticesX: [0, 10, 0], verticesY: [0, -20, 0], verticesZ: [0, 0, 10] };
            },
        },
    },
    mapManager: { getMapForWorldTile: () => undefined },
    getPlayerRawPlane: () => 0,
    buildModelTrianglePoints: (
        model: { verticesX: number[] },
        mapVertex: (i: number) => { x: number; y: number; z: number },
    ) => model.verticesX.map((_, i) => {
        const p = mapVertex(i);
        return [p.x, p.y, p.z] as const;
    }),
} as any;

ClientState.baseX = 3200;
ClientState.baseY = 3200;

// "Use Tinderbox -> Logs" on the ground: the entry names the logs by item id and local tile.
const useOnLogs = { targetType: MenuTargetType.OBJ, targetId: LOGS, mapX: 22, mapY: 18 };
const target = resolveItemHighlightTargetFromEntry(host, useOnLogs);
assert.deepEqual(target, { kind: "item", itemId: LOGS, quantity: 1, tileX: 3222, tileY: 3218, plane: 0 });

// Scenery and NPC entries are not items.
assert.equal(resolveItemHighlightTargetFromEntry(host, { ...useOnLogs, targetType: MenuTargetType.LOC }), undefined);
// Nothing of that item on the tile.
assert.equal(resolveItemHighlightTargetFromEntry(host, { ...useOnLogs, targetId: 995 }), undefined);

// The outline is the stack's model at the tile's centre.
const points = buildItemModelHighlightTriangles(host, target!)!;
assert.deepEqual(requestedModels.at(-1), [LOGS, 1]);
assert.deepEqual(points[0], [(3222 * 128 + 64) / 128, 0, (3218 * 128 + 64) / 128]);
assert.deepEqual(points[1], [(3222 * 128 + 64 + 10) / 128, -20 / 128, (3218 * 128 + 64) / 128]);

// The interact highlight clears once the logs are gone.
assert.equal(isItemHighlightTargetStillPresent(host, target!), true);
stacks = stacks.filter((s) => s.itemId !== LOGS);
assert.equal(isItemHighlightTargetStillPresent(host, target!), false);

console.log("interact-highlight-items: ok");
