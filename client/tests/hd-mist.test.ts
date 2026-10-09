import assert from "node:assert/strict";
import { HdMist, hdMistLevel } from "../game/plugins/hd/HdMist";

// Rolling land at height -4 (Y down) with a 3-tile-deep valley 8 tiles wide around x = 100.
const ground = (x: number) => (Math.abs(x - 100) < 4 ? -1 : -4);
const groundAt = (x: number, _z: number) => ground(x);

const mist = new HdMist();
const onHill = mist.uniform(80, 50, groundAt, 0);
assert.ok(onHill[0] < -3, "the level is the surrounding land, not the valley floor");
assert.ok(onHill[1] > 0, "mist is on once ground is loaded");
let level = onHill[0];
// Run down into the valley over a few seconds: the level must stay with the land, not drop to the floor.
for (let t = 1; t <= 5; t++) level = mist.uniform(100, 50, groundAt, t * 1000)[0];
assert.ok(level < -2.5, "standing in the valley keeps the mist level above you");
assert.ok(ground(100) - level > 1.5, "so the valley floor stays well inside the mist");

assert.equal(hdMistLevel(0, 0, () => 0), undefined, "unloaded ground gives no level");
assert.equal(new HdMist().uniform(0, 0, () => 0, 0)[1], 0, "and no mist");
const teleported = mist.uniform(500, 500, () => -40, 6000);
assert.equal(teleported[0], -40, "a teleport snaps the level instead of sweeping through");
assert.equal(mist.uniform(500, 500, () => -40, 7000, false)[1], 0, "the Surface fog toggle turns the mist off");
console.log("hd mist ok");
