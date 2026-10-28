import "./browser-self";
import { strict as assert } from "node:assert";
import { mat4 } from "gl-matrix";

import { computeWebGPURoofPlaneLimit } from "../render/webgpu/frameConfig";

// Aboard a boat the player stands in deck coordinates, thousands of tiles from the camera. The
// roof check walked the line between them, looking up each tile's roof flag in every loaded map,
// every frame (and again for the hovered tile): docked at the Pandemonium, 40% of the WebGPU
// frame. The player's tile for roofs is now where the deck is drawn.
const DECK = 12;
let lookups = 0;
// The deck's placement: deck tile (15427, 15944) drawn at (3065, 2987), by the Pandemonium.
const deckPlacement = mat4.fromTranslation(mat4.create(), [3065 - 15427, 0, 2987 - 15944]);
const renderer: any = {
    mapManager: {
        mapSquares: new Map(),
        getMapForWorldTile: () => { lookups++; return undefined; },
        getMap: () => undefined,
    },
    worldEntityAnimator: { getMovement: (entity: number) => (entity === DECK ? deckPlacement : undefined) },
    osrsClient: {
        controlledPlayerServerId: 5,
        roofsHidden: false,
        followPlayerCamera: true,
        getCameraTargetPosition: () => undefined,
        camera: { getPosX: () => 3060, getPosZ: () => 2980, getScenePitchAngle: () => 128 },
        // Deck coordinates: tile (15427, 15944), as recorded.
        playerEcs: {
            getIndexForServerId: () => 0,
            getX: () => 15427 * 128 + 64,
            getY: () => 15944 * 128 + 64,
            getLevel: () => 0,
            getWorldViewId: () => DECK,
            size: () => 1,
        },
        worldViewManager: { getWorldEntity: () => ({ configId: -1 }) },
    },
};

assert.equal(computeWebGPURoofPlaneLimit(renderer), 3, "open sky: every plane drawn");
assert.ok(lookups < 64, `a few tiles between the camera and the drawn deck, not thousands (${lookups} lookups)`);

console.log("webgpu-roof-on-deck: ok");
