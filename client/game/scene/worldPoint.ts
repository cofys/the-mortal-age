import { unpackTemplateChunk } from "../../common/instance/InstanceTypes";

/** A world tile (RuneLite's WorldPoint). */
export type WorldPoint = { readonly x: number; readonly y: number; readonly plane: number };

const CHUNK_SIZE = 8;

/** RuneLite's WorldPoint.getRegionID: 64x64 tile regions. */
export function regionIdOf(x: number, y: number): number {
    return ((x >> 6) << 8) | (y >> 6);
}

export function regionLocal(v: number): number {
    return v & 63;
}

/** The tile at region-local x/y of a region. */
export function fromRegion(regionId: number, regionX: number, regionY: number, plane: number): WorldPoint {
    return { x: ((regionId >> 8) << 6) + regionX, y: ((regionId & 0xff) << 6) + regionY, plane };
}

/** RuneLite's WorldPoint.rotate: a quarter turn per step within the tile's 8x8 chunk. */
export function rotateInChunk(point: WorldPoint, rotation: number): WorldPoint {
    const chunkX = point.x & -CHUNK_SIZE;
    const chunkY = point.y & -CHUNK_SIZE;
    const x = point.x & (CHUNK_SIZE - 1);
    const y = point.y & (CHUNK_SIZE - 1);
    switch (rotation & 3) {
        case 1: return { x: chunkX + y, y: chunkY + (CHUNK_SIZE - 1 - x), plane: point.plane };
        case 2: return { x: chunkX + (CHUNK_SIZE - 1 - x), y: chunkY + (CHUNK_SIZE - 1 - y), plane: point.plane };
        case 3: return { x: chunkX + (CHUNK_SIZE - 1 - y), y: chunkY + x, plane: point.plane };
        default: return point;
    }
}

/** An instance's chunk templates and scene base (ClientState's). */
export type InstanceScene = { templates: number[][][] | null; baseX: number; baseY: number };

/** The map regions in the 13-chunk scene, or the source regions copied into an instance. */
export function sceneRegionIds(scene: InstanceScene): Set<number> {
    const regions = new Set<number>();
    if (scene.templates) {
        for (const plane of scene.templates) for (const column of plane) for (const packed of column) {
            if (packed === -1 || packed === undefined) continue;
            const { chunkX, chunkY } = unpackTemplateChunk(packed);
            regions.add(regionIdOf(chunkX * CHUNK_SIZE, chunkY * CHUNK_SIZE));
        }
    } else {
        const lastX = (scene.baseX + 13 * CHUNK_SIZE - 1) >> 6;
        const lastY = (scene.baseY + 13 * CHUNK_SIZE - 1) >> 6;
        for (let x = scene.baseX >> 6; x <= lastX; x++) {
            for (let y = scene.baseY >> 6; y <= lastY; y++) regions.add((x << 8) | y);
        }
    }
    return regions;
}

/**
 * RuneLite's WorldPoint.fromLocalInstance: inside an instance, the template (real-world) tile
 * a scene tile was copied from; outside one, the tile itself.
 */
export function fromLocalInstance(scene: InstanceScene, point: WorldPoint): WorldPoint {
    if (!scene.templates) return point;
    const sceneX = point.x - scene.baseX;
    const sceneY = point.y - scene.baseY;
    const packed = scene.templates[point.plane]?.[sceneX >> 3]?.[sceneY >> 3];
    if (packed === undefined || packed === -1) return point;
    const t = unpackTemplateChunk(packed);
    const x = t.chunkX * CHUNK_SIZE + (sceneX & (CHUNK_SIZE - 1));
    const y = t.chunkY * CHUNK_SIZE + (sceneY & (CHUNK_SIZE - 1));
    return rotateInChunk({ x, y, plane: t.plane }, 4 - t.rotation);
}

/**
 * RuneLite's WorldPoint.toLocalInstance: every scene tile in the instance copied from this
 * template tile (or the tile itself outside an instance).
 */
export function toLocalInstance(scene: InstanceScene, point: WorldPoint): WorldPoint[] {
    if (!scene.templates) return [point];
    const out: WorldPoint[] = [];
    scene.templates.forEach((planes, z) =>
        planes.forEach((column, cx) =>
            column.forEach((packed, cy) => {
                if (packed === -1 || packed === undefined) return;
                const t = unpackTemplateChunk(packed);
                const tx = t.chunkX * CHUNK_SIZE;
                const ty = t.chunkY * CHUNK_SIZE;
                if (point.x < tx || point.x >= tx + CHUNK_SIZE || point.y < ty || point.y >= ty + CHUNK_SIZE) return;
                if (t.plane !== point.plane) return;
                const p = {
                    x: scene.baseX + cx * CHUNK_SIZE + (point.x & (CHUNK_SIZE - 1)),
                    y: scene.baseY + cy * CHUNK_SIZE + (point.y & (CHUNK_SIZE - 1)),
                    plane: z,
                };
                out.push(rotateInChunk(p, t.rotation));
            }),
        ),
    );
    return out;
}
