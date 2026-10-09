import assert from "node:assert/strict";
import { Camera } from "../game/Camera";
import { worldToScreen } from "../render/render/terrain/pick";

// Camera at the origin looking north (+z) on the level.
const camera = new Camera(0, 0, 0, 0, 0);
camera.setViewPitchOverride(0);
camera.update(640, 480);
const host = { osrsClient: { camera }, app: { width: 640, height: 480 } } as any;

const ahead = worldToScreen(host, 0, 0, 10);
assert.ok(ahead && Math.abs(ahead[0] - 320) < 1, "a point straight ahead lands mid-screen");
assert.equal(worldToScreen(host, 0, 0, -10), undefined, "a point behind the camera is not mirrored onto the screen");
assert.equal(worldToScreen(host, 0, 0, 0), undefined, "a point at the camera has no screen position");
console.log("world to screen ok");
