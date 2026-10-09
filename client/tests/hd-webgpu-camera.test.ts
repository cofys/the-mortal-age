import assert from "node:assert/strict";
import { test } from "node:test";

import { shortestYawDelta, wrapYaw } from "../render/webgpu/camera";

test("wrapYaw keeps RS yaw in [0, 2048)", () => {
    assert.equal(wrapYaw(0), 0);
    assert.equal(wrapYaw(2048), 0);
    assert.equal(wrapYaw(-1), 2047);
    assert.equal(wrapYaw(2049), 1);
    assert.equal(wrapYaw(1024), 1024);
});

test("shortestYawDelta takes the short way across the 0/2048 seam", () => {
    assert.equal(shortestYawDelta(10, 2040), 18);
    assert.equal(shortestYawDelta(2040, 10), -18);
    assert.equal(shortestYawDelta(500, 0), 500);
    assert.equal(shortestYawDelta(1500, 0), -548);
    assert.equal(shortestYawDelta(0, 0), 0);
});
