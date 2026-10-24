import { HD_OBJECT_LIGHTS_BY_ID, type HdObjectLightDefinition } from "./hdObjectLightData";
import type { Model } from "../../../rs/model/Model";

/** Coloured flames/glass near a defined light's height; exclude dark wood and metal. */
export function isHdLightSourceFace(locId: number, model: Model, face: number): boolean {
    const lights = HD_OBJECT_LIGHTS_BY_ID[locId];
    if (!lights || (model.faceTextures?.[face] ?? -1) >= 0) return false;
    const hsl = model.faceColors[face];
    // shortcut: grey source faces need explicit material tags if new lamps use them.
    if (((hsl >> 7) & 7) < 3 || (hsl & 127) < 28) return false;
    const y = (model.verticesY[model.indices1[face]] + model.verticesY[model.indices2[face]]
        + model.verticesY[model.indices3[face]]) / 3;
    return lights.some(light => Math.abs(y + light.height) <= 50);
}

/** The slice of a map square collectHdLights reads, shared by WebGLMapSquare and WebGPUMapSquare. */
export interface HdLightsMap {
    getRenderBaseWorldX(): number;
    getRenderBaseWorldY(): number;
    tileLocOffsetsByLevel?: Uint32Array[];
    tileLocIdsByLevel?: Int32Array[];
    tileLocTypeRotByLevel?: Uint8Array[];
}

/** The slice of a renderer collectHdLights reads; both backends satisfy it. */
export interface HdLightsHost {
    playerPosUni: ArrayLike<number>;
    getPlayerRawPlane(): number;
    sampleHeightAtExactPlane(worldX: number, worldZ: number, plane: number): number;
    mapManager: { visibleMapCount: number; visibleMaps: ReadonlyArray<HdLightsMap> };
    osrsClient: { locTypeLoader: { load(id: number): { sizeX: number; sizeY: number } } };
}

const ABSOLUTE_ALIGNMENTS = ["NORTH", "NORTHEAST", "EAST", "SOUTHEAST", "SOUTH", "SOUTHWEST", "WEST", "NORTHWEST"];
const RELATIVE_ALIGNMENTS = ["BACK", "BACKLEFT", "LEFT", "FRONTLEFT", "FRONT", "FRONTRIGHT", "RIGHT", "BACKRIGHT"];

export function hdLightOffset(alignment: string, rotation: number, width: number, length: number): [number, number] {
    const name = alignment.replace("_CORNER", "");
    const relative = RELATIVE_ALIGNMENTS.indexOf(name);
    const absolute = ABSOLUTE_ALIGNMENTS.indexOf(name);
    if (relative < 0 && absolute < 0) return [0, 0];
    const angle = (relative >= 0 ? relative + rotation * 2 : absolute) * Math.PI / 4;
    const radius = alignment.endsWith("_CORNER") ? Math.hypot(width, length) / 2 : width / 2;
    return [radius * Math.sin(angle), radius * Math.cos(angle) * length / width];
}

export function animateHdLight(light: HdObjectLightDefinition, seed: number, time: number): number {
    const range = Math.max(0, light.range) / 100;
    if (light.type === "PULSE" && light.duration > 0) {
        const phase = ((time + (seed & 2047)) % light.duration) / light.duration;
        return 1 - range + (1 - Math.abs(phase * 2 - 1)) * range * 2;
    }
    if (light.type === "FLICKER") {
        const t = ((time + (seed & 32767)) % 60000) * Math.PI * 2 / 60000;
        const wave = (Math.cos(11 * t) ** 2 + Math.cos(17 * t) ** 4 + Math.cos(23 * t) ** 6 +
            Math.cos(31 * t) ** 2 + Math.cos(71 * t) ** 2 / 3 + Math.cos(151 * t) ** 2 / 7) / 4.335;
        return 1 - range + wave * range * 2;
    }
    return 1;
}

type LightCandidate = { x: number; y: number; z: number; light: HdObjectLightDefinition; seed: number; distance: number };
const nearestFirst = (a: LightCandidate, b: LightCandidate) => a.distance - b.distance;

function collectMapLights(host: HdLightsHost, map: HdLightsMap, plane: number, candidates: LightCandidate[]): void {
    const playerX = host.playerPosUni[0];
    const playerZ = host.playerPosUni[1];
    const offsets = map.tileLocOffsetsByLevel?.[plane];
    const ids = map.tileLocIdsByLevel?.[plane];
    const rotations = map.tileLocTypeRotByLevel?.[plane];
    if (!offsets || !ids) return;
    const baseX = map.getRenderBaseWorldX();
    const baseZ = map.getRenderBaseWorldY();
    const minX = Math.max(0, Math.floor(playerX - baseX - 16));
    const maxX = Math.min(63, Math.ceil(playerX - baseX + 16));
    const minZ = Math.max(0, Math.floor(playerZ - baseZ - 16));
    const maxZ = Math.min(63, Math.ceil(playerZ - baseZ + 16));
    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const tile = z * 64 + x;
        for (let i = offsets[tile]; i < offsets[tile + 1]; i++) {
            const definitions = HD_OBJECT_LIGHTS_BY_ID[ids[i]];
            if (!definitions) continue;
            const loc = host.osrsClient.locTypeLoader.load(ids[i]);
            const rotation = (rotations?.[i] ?? 0) >> 6;
            const width = rotation & 1 ? loc.sizeY : loc.sizeX;
            const length = rotation & 1 ? loc.sizeX : loc.sizeY;
            for (const light of definitions) {
                const [offsetX, offsetZ] = hdLightOffset(light.alignment, rotation, width, length);
                const lx = baseX + x + width / 2 + offsetX;
                const lz = baseZ + z + length / 2 + offsetZ;
                const height = host.sampleHeightAtExactPlane(lx, lz, plane);
                candidates.push({
                    x: lx, y: height - light.height / 128, z: lz, light, seed: ids[i] ^ (x << 7) ^ z,
                    distance: (lx - playerX) ** 2 + (lz - playerZ) ** 2,
                });
            }
        }
    }
}

function writeLights(candidates: LightCandidate[], positions: Float32Array, colors: Float32Array, time: number): number {
    // Match the source's nearest-light budget, bounded by the shader's uniform capacity.
    candidates.sort(nearestFirst);
    const count = Math.min(positions.length / 4, candidates.length);
    for (let i = 0; i < count; i++) {
        const candidate = candidates[i], light = candidate.light;
        const animation = animateHdLight(light, candidate.seed, time);
        const offset = i * 4;
        positions[offset] = candidate.x;
        positions[offset + 1] = candidate.y;
        positions[offset + 2] = candidate.z;
        positions[offset + 3] = Math.max(0.5, light.radius / 128 * animation);
        colors[offset] = light.color[0];
        colors[offset + 1] = light.color[1];
        colors[offset + 2] = light.color[2];
        colors[offset + 3] = light.strength / 16 * animation;
    }
    return count;
}

/** Stateless collector retained for callers without map-change notifications. */
export function collectHdLights(host: HdLightsHost, positions: Float32Array, colors: Float32Array, time: number): number {
    const candidates: LightCandidate[] = [];
    const plane = host.getPlayerRawPlane();
    for (let m = 0; m < host.mapManager.visibleMapCount; m++) {
        collectMapLights(host, host.mapManager.visibleMaps[m], plane, candidates);
    }
    return writeLights(candidates, positions, colors, time);
}

/** Static locations are independent of flicker/pulse time and of camera-driven map ordering. */
export class HdLights {
    private readonly maps = new Map<HdLightsMap, { revision: number; x: number; z: number; plane: number;
        limit: number; seen: number; candidates: LightCandidate[] }>();
    private readonly candidates: LightCandidate[] = [];
    private generation = 0;

    collect(host: HdLightsHost, positions: Float32Array, colors: Float32Array, time: number, revision: number): number {
        const generation = ++this.generation;
        const x = host.playerPosUni[0], z = host.playerPosUni[1], plane = host.getPlayerRawPlane();
        const limit = positions.length / 4;
        let count = 0;
        for (let m = 0; m < host.mapManager.visibleMapCount; m++) {
            const map = host.mapManager.visibleMaps[m];
            let input = this.maps.get(map);
            if (!input || input.revision !== revision || input.x !== x || input.z !== z ||
                input.plane !== plane || input.limit !== limit) {
                const candidates: LightCandidate[] = [];
                collectMapLights(host, map, plane, candidates);
                candidates.sort(nearestFirst);
                // Retain only the global shader budget per map, including its array storage.
                input = { revision, x, z, plane, limit, seen: generation,
                    candidates: candidates.length > limit ? candidates.slice(0, limit) : candidates };
                this.maps.set(map, input);
            } else input.seen = generation;
            // Preserve the current map order for equal-distance lights, as the uncached scan does.
            for (const candidate of input.candidates) this.candidates[count++] = candidate;
        }
        this.candidates.length = count;
        for (const map of this.maps.keys()) if (this.maps.get(map)!.seen !== generation) this.maps.delete(map);
        return writeLights(this.candidates, positions, colors, time);
    }

    dispose(): void {
        this.maps.clear();
        this.candidates.length = 0;
    }
}
