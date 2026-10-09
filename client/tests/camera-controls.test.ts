import assert from "node:assert/strict";

import { Camera } from "../game/Camera";

const camera = new Camera(0, 0, 0, 256, 512);
camera.move(0, 0, -1);
assert.ok(camera.getPosX() > 0.99, "forward should follow the viewed direction");

camera.snapToPosition(0, 0, 0);
camera.move(0, 0, 1, true);
assert.ok(camera.getPosY() < 0, "zooming out should move the camera upward");

camera.snapToPitch(0);
assert.equal(camera.getControlPitchAngle(), 128, "control pitch should retain the player's angle");
camera.setScenePitchOverride(300);
assert.equal(camera.getScenePitchAngle(), 300, "terrain pressure should drive the rendered pitch");
assert.equal(camera.getControlPitchAngle(), 128, "terrain pressure must not alter camera controls");
camera.setScenePitchOverride(undefined);
assert.equal(camera.getScenePitchAngle(), 128, "clearing terrain pressure should restore control pitch");

camera.setViewPitchOverride(-256);
assert.equal(camera.getScenePitchAngle(), -256, "view plugins must support looking upward");
camera.setViewPitchOverride(-0.25);
assert.equal(camera.getScenePitchAngle(), -0.25, "small mouse deltas must accumulate without truncation");
camera.setViewPitchOverride(-600);
assert.equal(camera.getScenePitchAngle(), -480, "close camera can look nearly vertically upward");
camera.setViewPitchOverride(600);
assert.equal(camera.getScenePitchAngle(), 480, "close camera can look nearly vertically downward");
camera.setViewPitchOverride(undefined);
assert.equal(camera.getScenePitchAngle(), 128, "clearing a view override should restore camera controls");

console.log("camera control orientation ok");
