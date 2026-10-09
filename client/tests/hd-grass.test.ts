import assert from "node:assert/strict";
import { grassBladesForTile, grassDensity } from "../game/plugins/hd/webgpu/hd-clutter";

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
console.log("hd grass ok");
