import assert from "node:assert/strict";
import { test } from "node:test";
import { mat4 } from "gl-matrix";
import { Frustum } from "../game/Frustum";
import { actorBoundsVisible, packedActorBounds } from "../render/ActorVisibility";

function frustum(x = 0): Frustum {
    const f = new Frustum();
    f.setPlanes(mat4.ortho(mat4.create(), x - 5, x + 5, -5, 5, -5, 5));
    return f;
}

function vertex(x: number, y: number, z: number): Uint8Array {
    const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
    const fraction = (v: number) => Math.round((v - Math.floor(v)) * 1024);
    view.setUint32(0, (Math.floor(x) + 16384) << 17, true);
    view.setUint32(4, Math.floor(y) + 16384, true);
    view.setUint32(8, (Math.floor(z) + 16384) << 17, true);
    view.setUint32(16, fraction(x) | (fraction(y) << 10) | (fraction(z) << 20), true);
    return bytes;
}

test("actor bounds cover final opaque/alpha geometry and fractional positions under every yaw", () => {
    const bounds = packedActorBounds(vertex(3.5, -256.25, 4.5), vertex(-640.5, 32.5, 128.25))!;
    assert.equal(bounds[1], -32.5);
    assert.equal(bounds[2], 256.25);
    assert.equal(bounds[0], Math.hypot(-640.5, 128.25));
    for (let yaw = 0; yaw < 2048; yaw += 13) {
        const angle = yaw * Math.PI / 1024;
        const x = -640.5 * Math.cos(angle) - 128.25 * Math.sin(angle);
        const z = -640.5 * Math.sin(angle) + 128.25 * Math.cos(angle);
        assert.ok(Math.abs(x) <= bounds[0] + 1e-10 && Math.abs(z) <= bounds[0] + 1e-10);
    }
    assert.equal(packedActorBounds(new Uint8Array(), new Uint8Array()), undefined);
    assert.equal(packedActorBounds(new Uint8Array(12), new Uint8Array()), undefined);
});

test("camera culling retains edge-intersecting actors and visible shadow casters", () => {
    const bounds = [128, 0, 256] as const, camera = frustum();
    assert.equal(actorBoundsVisible(bounds, 0, 0, 0, 0, camera, null), true);
    assert.equal(actorBoundsVisible(bounds, 6, 0, 0, 0, camera, null), true, "the center alone is outside");
    assert.equal(actorBoundsVisible(bounds, 8, 0, 0, 0, camera, null), false);
    assert.equal(actorBoundsVisible(bounds, 20, 0, 0, 0, camera, frustum(20)), true);
    assert.equal(actorBoundsVisible(bounds, 40, 0, 0, 0, camera, frustum(20)), false);
    assert.equal(actorBoundsVisible(bounds, 40, 0, 0, 0, camera, undefined), true, "unknown shadow volume");
    assert.equal(actorBoundsVisible(undefined, 40, 0, 0, 0, camera, null), true, "unknown poses stay visible");
});

test("vertical actor bounds include sloped ground and camera movement", () => {
    const camera = frustum(), bounds = [64, 0, 128] as const;
    assert.equal(actorBoundsVisible(bounds, 0, 0, 7, 8, camera, null), false);
    assert.equal(actorBoundsVisible(bounds, 0, 0, 4, 8, camera, null), true);
    assert.equal(actorBoundsVisible(bounds, 20, 0, 0, 0, camera, null), false);
    camera.setPlanes(mat4.ortho(mat4.create(), 15, 25, -5, 5, -5, 5));
    assert.equal(actorBoundsVisible(bounds, 20, 0, 0, 0, camera, null), true);
});
