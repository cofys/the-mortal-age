import assert from "node:assert/strict";

import {
    INTERACTION_WORLD_DEFAULT,
    TileInteractionMode,
    interactionModes,
} from "../game/InteractionModes";
import {
    HEADING_FLASH_MS,
    HeadingIndicator,
    arrowParts,
    isOverBoat,
    placeArrow,
    type OverlayTriangleBatch,
} from "../game/sailing/HeadingIndicator";
import { WorldEntity } from "../game/worldview/WorldEntity";

// A one-triangle stand-in for the cache's arrow models: tip at model z -8, back at z 50.
const model = (colour: number) =>
    ({
        faceCount: 1,
        faceColors: new Uint16Array([colour]),
        faceAlphas: new Int8Array([50]),
        indices1: new Int32Array([0]),
        indices2: new Int32Array([1]),
        indices3: new Int32Array([2]),
        verticesX: new Int32Array([0, -50, 50]),
        verticesY: new Int32Array([-22, -22, -22]),
        verticesZ: new Int32Array([-8, 50, 50]),
    }) as any;
const WHITE = 57378;
const YELLOW = 57379;
const models: Record<number, any> = { [WHITE]: model(127), [YELLOW]: model(10198) };

{
    const parts = arrowParts(models[WHITE]);
    assert.equal(parts.length, 1);
    assert.ok(Math.abs(parts[0].rgba[3] - (1 - 50 / 255)) < 1e-6, "face alpha is transparency");

    // Pointing north (1024) from the origin, 512 fine units out: the tip is the northmost vertex.
    const out: OverlayTriangleBatch[] = [];
    placeArrow(out, parts, 0, 0, 512, 1024, 0);
    const [tipX, , tipY, backX, , backY] = out[0].positions;
    assert.ok(Math.abs(tipX) < 1e-9 && Math.abs(tipY - 520 / 128) < 1e-9, "tip 520 fine north");
    assert.ok(backY < tipY, "the arms trail back toward the boat");
    assert.ok(Math.abs(backX) > 0.3, "the arms spread sideways");
}

const boat = new WorldEntity(3000);
boat.setPosition({ x: 100 * 128, y: 0, z: 100 * 128, orientation: 0 });
assert.equal(isOverBoat(boat, 8, 8, 100 * 128 + 400, 100 * 128), true, "within the 8x8 footprint");
assert.equal(isOverBoat(boat, 8, 8, 100 * 128 + 600, 100 * 128), false);

const frame = (now: number, mouse?: { x: number; y: number }) => ({
    now,
    boat,
    boatIndex: 3000,
    sizeX: 8,
    sizeZ: 8,
    surfaceHeight: 0,
    mouseSeaPoint: mouse,
    getModel: (id: number) => models[id],
});
const colours = (batches?: OverlayTriangleBatch[]) => (batches ?? []).map((b) => Math.round(b.rgba[2] * 255));
const north = { x: 100 * 128, y: 110 * 128 };

{
    const indicator = new HeadingIndicator();
    indicator.setModels([WHITE, YELLOW]);
    interactionModes.clear();
    assert.equal(indicator.build(frame(0, north)), undefined, "walk mode: no arrow");

    interactionModes.set(INTERACTION_WORLD_DEFAULT, TileInteractionMode.Heading, 1);
    interactionModes.set(3000, TileInteractionMode.Walk, 1);
    const white = indicator.build(frame(0, north));
    assert.equal(white?.length, 1, "heading mode: the white arrow follows the mouse");
    assert.equal(indicator.build(frame(0, { x: 100 * 128 + 100, y: 100 * 128 }))?.length, undefined, "not over the boat");
    assert.equal(indicator.build(frame(0)), undefined, "not with the mouse off the game view");

    indicator.onHeadingSet(12, 1000);
    const both = indicator.build(frame(1000 + HEADING_FLASH_MS - 1, north));
    assert.equal(both?.length, 2, "the yellow arrow shows alongside the white one");
    assert.notDeepEqual(colours(both)[0], colours(both)[1]);
    assert.equal(indicator.build(frame(1000 + HEADING_FLASH_MS + 1, north))?.length, 1, "the yellow arrow fades");
    interactionModes.clear();
}

console.log("heading-indicator: ok");
