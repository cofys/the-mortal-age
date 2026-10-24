import type { Frustum } from "../game/Frustum";
import { ACTOR_VERTEX_STRIDE } from "./buffer/ActorNormals";

/** Final CPU pose: yaw-independent radius and vertical limits, in model units. */
export type ActorBounds = readonly [radius: number, minY: number, maxY: number];

export function packedActorBounds(opaque: Uint8Array, alpha: Uint8Array): ActorBounds | undefined {
    let radiusSquared = 0, minY = Infinity, maxY = -Infinity;
    for (const vertices of [opaque, alpha]) {
        if (vertices.byteLength % ACTOR_VERTEX_STRIDE !== 0) return undefined;
        const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
        for (let offset = 0; offset < vertices.byteLength; offset += ACTOR_VERTEX_STRIDE) {
            const fractions = view.getUint32(offset + 16, true);
            const x = (view.getUint32(offset, true) >>> 17) - 16384 + (fractions & 1023) / 1024;
            const y = 16384 - (view.getUint32(offset + 4, true) & 32767) - ((fractions >>> 10) & 1023) / 1024;
            const z = (view.getUint32(offset + 8, true) >>> 17) - 16384 + ((fractions >>> 20) & 1023) / 1024;
            radiusSquared = Math.max(radiusSquared, x * x + z * z);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
    }
    return Number.isFinite(minY) ? [Math.sqrt(radiusSquared), minY, maxY] : undefined;
}

const box = [[0, 0, 0], [0, 0, 0]];

/** Unknown shadow volumes keep actors; a camera-only rejection can remove visible shadows. */
export function actorBoundsVisible(bounds: ActorBounds | undefined, x: number, z: number,
    groundMin: number, groundMax: number, camera: Frustum, shadow: Frustum | null | undefined): boolean {
    if (!bounds || shadow === undefined) return true;
    // Cover floating-point rotation, terrain interpolation truncation and depth priority bias.
    const padding = 0.2;
    const radius = bounds[0] / 128 + padding;
    box[0][0] = x - radius; box[1][0] = x + radius;
    box[0][2] = z - radius; box[1][2] = z + radius;
    box[0][1] = groundMin + bounds[1] / 128 - padding;
    box[1][1] = groundMax + bounds[2] / 128 + padding;
    return camera.intersectsBox(box) || !!shadow?.intersectsBox(box);
}
