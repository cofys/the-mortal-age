import assert from "node:assert/strict";

// PicoGL expects a browser global when SceneRaycaster imports WebGLMapSquare.
(globalThis as any).self = globalThis;
const { SceneRaycaster } = require("../game/scene/SceneRaycaster");
const { Ray } = require("../game/math/Raycast");

// NPC type 0 is the Tool Leprechaun (#1513): it must be pickable like any other type.
const npcEcs = {
    queryByMap: () => [1],
    isActive: () => true,
    isLinked: () => true,
    getMapId: () => 7,
    getWorldViewId: () => -1,
    getWorldX: () => 10 * 128 + 64,
    getWorldY: () => 10 * 128 + 64,
    getSize: () => 1,
    getNpcTypeId: () => 0,
    getLevel: () => 0,
    getServerId: () => 42,
};
const npcTypeLoader = { load: (id: number) => ({ id, modelIds: [56206] }) };
const raycaster = new SceneRaycaster({}, { npcEcs, npcTypeLoader });
raycaster.sampleHeightAt = () => 0;

const hits: any[] = [];
const ray = new Ray([10.5, -10, 10.5], [0, 1, 0]);
raycaster.collectNpcHitsForMap({ id: 7, mapX: 0, mapY: 0 }, ray, 100, hits, 0);

assert.equal(hits.length, 1);
assert.equal(hits[0].interactId, 0);
assert.equal(hits[0].npcServerId, 42);
console.log("ok scene-raycaster-npc-type-zero");
