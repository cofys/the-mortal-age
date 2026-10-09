import { Model } from "../../rs/model/Model";
import { Scene } from "../../rs/scene/Scene";
import { SceneTileModel } from "../../rs/scene/SceneTileModel";
import { getBridgeLinkedBelow, isBridgeSurfaceTile } from "../../game/scene/BridgeTiles";
import { hdGroundMaterial } from "../../game/plugins/hd/HdGroundMaterials";
import type { SceneBuffer } from "../buffer/SceneBuffer";

export const SCENERY_CHUNK_SIZE = 8;

export function addTerrainCell(buffer: SceneBuffer, scene: Scene, level: number, x: number, y: number, maxLevel: number, offset: number): void {
    if (level === 0 && (scene.tileRenderFlags[1][x][y] & 8) !== 0) {
        const upper = scene.tiles[1][x][y];
        if (upper) buffer.addTerrainTile(upper, offset, offset);
    }
    const tile = scene.tiles[level][x][y];
    if (!tile || tile.skipRender || !scene.isPlayerLevel(level, x, y, maxLevel)) return;
    if (level === 1 && (scene.tileRenderFlags[1][x][y] & 8) !== 0) return;
    buffer.addTerrainTile(tile, offset, offset);
    if (level === 0) {
        const linked = getBridgeLinkedBelow(tile);
        if (linked) buffer.addTerrainTile(linked, offset, offset);
    }
}

/** Half-resolution interiors; keep edges exact wherever the adjacent patch stays detailed. */
export function addFarTerrainChunk(buffer: SceneBuffer, scene: Scene, level: number, startX: number, startY: number, endX: number, endY: number, maxLevel: number, offset: number): void {
    const simplePatches = new Map<number, boolean>();
    const isSimplePatch = (x: number, y: number): boolean => {
        if (x < startX || y < startY || x + 2 > endX || y + 2 > endY) return false;
        const key = x * scene.sizeY + y;
        const cached = simplePatches.get(key);
        if (cached !== undefined) return cached;
        const tiles = [scene.tiles[level][x]?.[y], scene.tiles[level][x + 1]?.[y],
            scene.tiles[level][x]?.[y + 1], scene.tiles[level][x + 1]?.[y + 1]];
        const first = tiles[0]?.tileModel;
        const heights = scene.tileHeights[level];
        const smooth = x + 2 <= endX && y + 2 <= endY &&
            Math.abs(heights[x + 1][y] - (heights[x][y] + heights[x + 2][y]) / 2) <= 16 &&
            Math.abs(heights[x + 1][y + 2] - (heights[x][y + 2] + heights[x + 2][y + 2]) / 2) <= 16 &&
            Math.abs(heights[x][y + 1] - (heights[x][y] + heights[x][y + 2]) / 2) <= 16 &&
            Math.abs(heights[x + 2][y + 1] - (heights[x + 2][y] + heights[x + 2][y + 2]) / 2) <= 16;
        const simple = !!(smooth && first && tiles.every((tile, i) => {
            const tx = x + (i & 1), ty = y + (i >> 1), model = tile?.tileModel;
            return tile && !tile.skipRender && !isBridgeSurfaceTile(tile) && !getBridgeLinkedBelow(tile) &&
                // Keep the ground profile under scenery: its mesh was fitted to the original terrain.
                !tile.floorDecoration && !tile.wall && !tile.wallDecoration && tile.locs.length === 0 &&
                scene.isPlayerLevel(level, tx, ty, maxLevel) && (scene.tileRenderFlags[1][tx][ty] & 8) === 0 &&
                model && model.shape <= 1 && model.faces.length === 2 && model.underlayId === first.underlayId &&
                model.overlayId === first.overlayId && model.faces.every(face =>
                    face.isOverlay === first.faces[0].isOverlay && face.vertices.every(v => v.textureId === -1 && v.hsl >= 0));
        }));
        simplePatches.set(key, simple);
        return simple;
    };
    for (let x = startX; x < endX; x += 2) for (let y = startY; y < endY; y += 2) {
        if (!isSimplePatch(x, y)) {
            for (let dx = 0; dx < 2 && x + dx < endX; dx++) for (let dy = 0; dy < 2 && y + dy < endY; dy++)
                addTerrainCell(buffer, scene, level, x + dx, y + dy, maxLevel, offset);
            continue;
        }
        const tiles = [scene.tiles[level][x][y], scene.tiles[level][x + 1][y],
            scene.tiles[level][x][y + 1], scene.tiles[level][x + 1][y + 1]];
        const first = tiles[0]!.tileModel!;
        type Vertex = SceneTileModel["faces"][number]["vertices"][number];
        const sample = (px: number, py: number): Vertex => {
            const tile = tiles[Math.min(py, 1) * 2 + Math.min(px, 1)]!;
            return tile.tileModel!.faces.flatMap(face => face.vertices).find(v => v.x === (x + px) * 128 && v.z === (y + py) * 128)!;
        };
        const recipe = hdGroundMaterial(first.faces[0].isOverlay ? first.overlayId : first.underlayId,
            first.faces[0].isOverlay, first.faces[0].isOverlay ? first.overlayHsl : first.blendUnderlayHslSw);
        const vertex = (px: number, py: number) => {
            const v = sample(px, py);
            return buffer.vertexBuf.addVertex(v.x + offset, v.y, v.z + offset, v.hsl, 255, -recipe / 64, 0, -1);
        };
        const ring: number[] = [vertex(0, 0)];
        if (!isSimplePatch(x, y - 2)) ring.push(vertex(1, 0));
        ring.push(vertex(2, 0));
        if (!isSimplePatch(x + 2, y)) ring.push(vertex(2, 1));
        ring.push(vertex(2, 2));
        if (!isSimplePatch(x, y + 2)) ring.push(vertex(1, 2));
        ring.push(vertex(0, 2));
        if (!isSimplePatch(x - 2, y)) ring.push(vertex(0, 1));
        const center = vertex(1, 1);
        for (let i = 0; i < ring.length; i++) buffer.indices.push(center, ring[i], ring[(i + 1) % ring.length]);
    }
}

function isClosedMesh(model: Model): boolean {
    // Weld by position for this check; cache meshes may split a shared vertex for colour/UVs.
    const positions = Array.from({ length: model.verticesCount }, (_, i) =>
        `${model.verticesX[i]}:${model.verticesY[i]}:${model.verticesZ[i]}`);
    const edges = new Map<string, number>();
    for (let f = 0; f < model.faceCount; f++) {
        if (model.faceColors3[f] === -2) continue;
        const face = [model.indices1[f], model.indices2[f], model.indices3[f]];
        for (let e = 0; e < 3; e++) {
            const a = positions[face[e]], b = positions[face[(e + 1) % 3]];
            if (a === b) continue;
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    return edges.size > 0 && Array.from(edges.values()).every(count => count === 2);
}

/** Only cluster closed, un-contoured props. Open scenery often stitches to another model. */
export function simplifyFarModel(model: Model): Model {
    if (model.contourVerticesY || model.faceCount < 4 || !isClosedMesh(model)) return model;
    model.calculateBounds();
    const result = Object.assign(new Model(), model);
    result.verticesX = model.verticesX.slice();
    result.verticesY = model.verticesY.slice();
    result.verticesZ = model.verticesZ.slice();
    const groups = new Map<string, number[]>();
    for (let i = 0; i < model.verticesCount; i++) {
        // Closed architectural pieces can also meet at their outer planes.
        if (model.verticesX[i] === model.minX || model.verticesX[i] === model.maxX ||
            model.verticesY[i] === model.minY || model.verticesY[i] === model.maxY ||
            model.verticesZ[i] === model.minZ || model.verticesZ[i] === model.maxZ) continue;
        const key = `${Math.floor(model.verticesX[i] / 32)}:${Math.floor(model.verticesY[i] / 32)}:${Math.floor(model.verticesZ[i] / 32)}`;
        const group = groups.get(key);
        if (group) group.push(i); else groups.set(key, [i]);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        for (const field of ["verticesX", "verticesY", "verticesZ"] as const) {
            const values = result[field];
            if (!values) continue;
            const mean = Math.round(group.reduce((sum, i) => sum + values[i], 0) / group.length);
            for (const i of group) values[i] = mean;
        }
    }
    result.faceColors3 = model.faceColors3.slice();
    let remaining = 0;
    for (let i = 0; i < model.faceCount; i++) {
        if (!farFaceHasArea(result, i)) result.faceColors3[i] = -2;
        if (result.faceColors3[i] !== -2) remaining++;
    }
    // Reject a collapse that opens the prop or joins unrelated parts of its surface.
    return remaining >= 4 && isClosedMesh(result) ? result : model;
}

export function farFaceHasArea(model: Model, face: number): boolean {
    const a = model.indices1[face], b = model.indices2[face], c = model.indices3[face];
    const y = model.contourVerticesY ?? model.verticesY;
    const ux = model.verticesX[b] - model.verticesX[a], uy = y[b] - y[a], uz = model.verticesZ[b] - model.verticesZ[a];
    const vx = model.verticesX[c] - model.verticesX[a], vy = y[c] - y[a], vz = model.verticesZ[c] - model.verticesZ[a];
    return ux * vy !== uy * vx || uy * vz !== uz * vy || uz * vx !== ux * vz;
}
