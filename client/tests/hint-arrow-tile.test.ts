import { strict as assert } from "node:assert";

import { hintArrow, hintArrowTileOffset, setHintArrowTile } from "../game/HintArrow";

/**
 * Tile hint arrows as OSRS sends them: the height byte (the arrow sits height * 2 world units
 * up) and the position type (the tile's centre or one of its edges), with the floor beside it.
 */
function tileHintsKeepPositionHeightAndPlane(): void {
    // A door's arrow on the tutorial: west edge, height 128, floor 0.
    setHintArrowTile(3098, 3107, 128, (3 << 2) | 0);
    assert.equal(hintArrow.type, 2);
    assert.equal(hintArrow.height, 128);
    assert.equal(hintArrow.position, 3);
    assert.equal(hintArrow.plane, 0);

    setHintArrowTile(3088, 9520, 5, (2 << 2) | 1);
    assert.equal(hintArrow.position, 2);
    assert.equal(hintArrow.plane, 1);

    // An unknown position type falls back to the centre.
    setHintArrowTile(1, 1, 0, 7 << 2);
    assert.equal(hintArrow.position, 2);
}

function offsetsMatchTheOsrsClient(): void {
    assert.deepEqual(hintArrowTileOffset(2), [64, 64]);
    assert.deepEqual(hintArrowTileOffset(3), [0, 64]);
    assert.deepEqual(hintArrowTileOffset(4), [128, 64]);
    assert.deepEqual(hintArrowTileOffset(5), [64, 0]);
    assert.deepEqual(hintArrowTileOffset(6), [64, 128]);
}

tileHintsKeepPositionHeightAndPlane();
offsetsMatchTheOsrsClient();
