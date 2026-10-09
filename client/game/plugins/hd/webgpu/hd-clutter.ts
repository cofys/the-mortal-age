/**
 * 117 HD's WebGPU grass: dense, thin blades on grass terrain tiles near the player, coloured from
 * the ground they grow out of, lit and fogged with the HD sun/ambient/fog, and swaying in the wind.
 *
 * Placement is deterministic and CPU-side. Each grass tile gets up to BLADES_PER_TILE blades in
 * small clumps; each blade has a density rank, and the shader shows it only while that rank is
 * below the density at its current distance, so the field thins smoothly with distance and never
 * pops as the player walks. The set is rebuilt only when the player crosses an 8-tile bucket,
 * changes plane, or the visible map set changes; every rebuild stores enough blades for anywhere
 * in the bucket. HdWebGPU.afterScene calls setLight() and update(), then draw() records a load
 * pass on the HDR colour and depth targets before the post chain runs.
 */
import {
    GPU_BUFFER_USAGE,
    GPU_SHADER_STAGE,
    SCENE_DEPTH_FORMAT,
} from "../../../../render/webgpu/bindings";
import type { WebGPUMapSquare } from "../../../../render/webgpu/WebGPUMapSquare";
import type { WebGPURenderer } from "../../../../render/webgpu/WebGPURenderer";
import { getWorldResources } from "../../../../render/webgpu/overlays/rendererAccess";
import type { WebGPUSceneFrameTargets } from "../../../../render/webgpu/sceneExtension";
import { HdGroundMaterial } from "../HdGroundMaterials";
import { HD_CLUTTER_WGSL } from "./hd-clutter.wgsl";

const FLOATS_PER_VERTEX = 12; // root(3) + offset(3) + phase/tip/rank(3) + colour(3)
const VERTICES_PER_BLADE = 3; // one tapered triangle
const MAX_BLADES = 60000;
const BLADES_PER_TILE = 24;
const CLUMPS_PER_TILE = 3;
/** Rebuild when the player crosses this many tiles; blades are world-anchored so only the set changes. */
const REBUILD_BUCKET_TILES = 8;
/** How far the player can be from where the set was built and still be in the same bucket. */
const BUCKET_REACH = REBUILD_BUCKET_TILES * Math.SQRT2;
// Mirrors hd-clutter.wgsl: full density to 10 tiles, 20% by 30, shrunk away by 36.
const DENSE_DISTANCE = 10;
const THIN_DISTANCE = 30;
const FAR_DENSITY = 0.2;
const SHRINK_END = 36;
const LIGHT_FLOATS = 24;

/** Blades are a little darker than the ground's cache colour, like 117 HD's grass texture over it. */
const BLADE_TINT = [0.6, 0.68, 0.45];
/** Linear straw colour some blade tips fade towards. */
const DRY_TIP = [0.1, 0.08, 0.02];
/** Linear fallback for grass tiles without a colour (older map data). */
const FALLBACK_COLOR = [0.05, 0.09, 0.02];

/** The slice of WebGPUMapSquare the grass reads; the per-tile lookups are optional. */
type ClutterMap = WebGPUMapSquare & {
    plane?: number;
    getGroundMaterial?(level: number, tileX: number, tileY: number): number;
    getGroundColor?(level: number, tileX: number, tileY: number): number;
};

type GrassTile = { map: ClutterMap; level: number; localX: number; localY: number; distance: number };

/** Integer hash of a world tile (and variant seed), stable across frames and players. */
function hashTile(x: number, y: number, seed: number): number {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    return (Math.imul(h, 0xc2b2ae35) ^ (h >>> 16)) >>> 0;
}

const unit = (hash: number, shift: number) => ((hash >>> shift) & 0xff) / 255;

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/** Share of a tile's blades shown at this distance (the shader's density curve). */
export function grassDensity(distance: number): number {
    return 1 + (FAR_DENSITY - 1) * smoothstep(DENSE_DISTANCE, THIN_DISTANCE, distance);
}

/** Blades to store for a tile: enough for the player anywhere in the current bucket. */
export function grassBladesForTile(distance: number): number {
    if (distance > SHRINK_END + BUCKET_REACH) return 0;
    return Math.ceil(BLADES_PER_TILE * grassDensity(Math.max(0, distance - BUCKET_REACH)));
}

function createClutterPipeline(
    device: GPUDevice,
    sceneLayout: GPUBindGroupLayout,
    lightLayout: GPUBindGroupLayout,
    format: GPUTextureFormat,
): GPURenderPipeline {
    const module = device.createShaderModule({ code: HD_CLUTTER_WGSL, label: "hd-clutter" });
    return device.createRenderPipeline({
        label: "hd-clutter pipeline",
        // The exact scene layout object: WebGPU requires pipeline-layout identity for group(0).
        layout: device.createPipelineLayout({
            label: "hd-clutter pipeline layout",
            bindGroupLayouts: [sceneLayout, lightLayout],
        }),
        vertex: {
            module,
            entryPoint: "vs_clutter",
            buffers: [
                {
                    arrayStride: FLOATS_PER_VERTEX * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x3" as const },
                        { shaderLocation: 1, offset: 12, format: "float32x3" as const },
                        { shaderLocation: 2, offset: 24, format: "float32x3" as const },
                        { shaderLocation: 3, offset: 36, format: "float32x3" as const },
                    ],
                },
            ],
        },
        fragment: { module, entryPoint: "fs_clutter", targets: [{ format }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        // Opaque blades: depth-tested and written, so they sort themselves.
        depthStencil: {
            format: SCENE_DEPTH_FORMAT,
            depthWriteEnabled: true,
            depthCompare: "less-equal",
        },
    });
}

export class HdClutterLayer {
    private readonly device: GPUDevice;
    private pipeline?: GPURenderPipeline;
    private sceneBindGroup?: GPUBindGroup;
    private lightLayout?: GPUBindGroupLayout;
    private lightBuffer?: GPUBuffer;
    private lightBindGroup?: GPUBindGroup;
    private readonly light = new Float32Array(LIGHT_FLOATS);
    private vertexBuffer?: GPUBuffer;
    private vertexCapacity = 0;
    private vertices = new Float32Array(0);
    private floats = 0;
    private vertexCount = 0;
    private signature?: string;
    private disposed = false;

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** The HD lighting the blades share with the ground: linear ambient/sun colours, sun direction, fog, mist. */
    setLight(
        ambient: ArrayLike<number>,
        directional: ArrayLike<number>,
        lightDirection: ArrayLike<number>,
        fogColor: ArrayLike<number>,
        fog: ArrayLike<number>,
        mist: ArrayLike<number>,
    ): void {
        [ambient, directional, lightDirection, fogColor, fog, mist].forEach((values, slot) => {
            for (let i = 0; i < 4; i++) this.light[slot * 4 + i] = values[i] ?? 0;
        });
    }

    /**
     * Rebuilds placement if the 8-tile bucket, plane or visible map set changed, and returns
     * whether there is geometry to draw. False without world resources or ground data.
     */
    update(renderer: WebGPURenderer): boolean {
        if (this.disposed) return false;
        const world = getWorldResources(renderer);
        const format = world?.extension?.sceneColorFormat;
        if (!world || !format) return false;
        this.lightLayout ??= this.device.createBindGroupLayout({
            label: "hd-clutter light layout",
            entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.VERTEX, buffer: { type: "uniform" } }],
        });
        if (!this.lightBuffer) {
            this.lightBuffer = this.device.createBuffer({
                label: "hd-clutter light",
                size: LIGHT_FLOATS * 4,
                usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
            });
            this.lightBindGroup = this.device.createBindGroup({
                label: "hd-clutter light",
                layout: this.lightLayout,
                entries: [{ binding: 0, resource: { buffer: this.lightBuffer } }],
            });
        }
        this.pipeline ??= createClutterPipeline(this.device, world.sceneUniformsLayout, this.lightLayout, format);
        this.sceneBindGroup = world.sceneBindGroup;
        this.device.queue.writeBuffer(this.lightBuffer, 0, this.light);

        const playerX = renderer.playerPosUni[0];
        const playerZ = renderer.playerPosUni[1];
        const playerPlane = renderer.getPlayerRawPlane();
        const maps = renderer.mapManager.visibleMaps as readonly ClutterMap[];
        const bucketX = Math.floor(playerX / REBUILD_BUCKET_TILES);
        const bucketZ = Math.floor(playerZ / REBUILD_BUCKET_TILES);
        let signature = `${bucketX},${bucketZ},${playerPlane}`;
        for (const map of maps) signature += `|${map.id}:${map.plane ?? ""}`;
        if (signature !== this.signature) {
            this.signature = signature;
            // Build around the bucket centre so every position in it is covered alike.
            this.build(maps, (bucketX + 0.5) * REBUILD_BUCKET_TILES, (bucketZ + 0.5) * REBUILD_BUCKET_TILES, playerPlane);
        }
        return this.vertexCount > 0;
    }

    /** Records one load pass that draws all blades into the scene HDR colour and depth targets. */
    draw(encoder: GPUCommandEncoder, frame: WebGPUSceneFrameTargets): void {
        if (this.disposed || !this.pipeline || !this.vertexBuffer || !this.sceneBindGroup ||
            !this.lightBindGroup || this.vertexCount === 0) {
            return;
        }
        const pass = encoder.beginRenderPass({
            label: "hd-clutter",
            colorAttachments: [{ view: frame.colorView, loadOp: "load", storeOp: "store" }],
            depthStencilAttachment: {
                view: frame.depthView,
                depthLoadOp: "load",
                depthStoreOp: "store",
            },
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.sceneBindGroup);
        pass.setBindGroup(1, this.lightBindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.draw(this.vertexCount);
        pass.end();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.vertexBuffer?.destroy();
        this.vertexBuffer = undefined;
        this.lightBuffer?.destroy();
        this.lightBuffer = undefined;
        this.vertexCapacity = 0;
        this.vertexCount = 0;
    }

    private build(maps: readonly ClutterMap[], centreX: number, centreZ: number, playerPlane: number): void {
        const reach = SHRINK_END + BUCKET_REACH;
        const tiles: GrassTile[] = [];
        for (const map of maps) {
            if (!map.getGroundMaterial) continue;
            const level = typeof map.plane === "number" ? map.plane | 0 : playerPlane;
            const baseX = map.getRenderBaseTileX();
            const baseY = map.getRenderBaseTileY();
            const span = map.getLocalTileSpan();
            if (span <= 0) continue;
            const minX = Math.max(0, Math.floor(centreX - reach - baseX));
            const maxX = Math.min(span - 1, Math.ceil(centreX + reach - baseX));
            const minY = Math.max(0, Math.floor(centreZ - reach - baseY));
            const maxY = Math.min(span - 1, Math.ceil(centreZ + reach - baseY));
            for (let localY = minY; localY <= maxY; localY++) {
                for (let localX = minX; localX <= maxX; localX++) {
                    if (map.getGroundMaterial(level, localX, localY) !== HdGroundMaterial.GRASS) continue;
                    const distance = Math.hypot(baseX + localX + 0.5 - centreX, baseY + localY + 0.5 - centreZ);
                    if (distance <= reach) tiles.push({ map, level, localX, localY, distance });
                }
            }
        }
        // Nearest first, so a full budget drops the far fringe rather than whole map squares.
        tiles.sort((a, b) => a.distance - b.distance);

        const maxFloats = MAX_BLADES * VERTICES_PER_BLADE * FLOATS_PER_VERTEX;
        if (this.vertices.length < maxFloats) this.vertices = new Float32Array(maxFloats);
        this.floats = 0;
        let blades = 0;
        for (const tile of tiles) {
            const count = Math.min(grassBladesForTile(tile.distance), MAX_BLADES - blades);
            if (count <= 0) break;
            this.pushTile(tile, count);
            blades += count;
        }
        this.vertexCount = this.floats / FLOATS_PER_VERTEX;
        this.upload();
    }

    /** Writes `count` blades for a grass tile, in clumps, coloured from the tile. */
    private pushTile({ map, level, localX, localY, distance }: GrassTile, count: number): void {
        const tileX = map.getRenderBaseTileX() + localX;
        const tileY = map.getRenderBaseTileY() + localY;
        const tileHash = hashTile(tileX, tileY, level);
        const packed = map.getGroundColor?.(level, localX, localY) ?? 0;
        const soil = packed
            ? [(packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff].map((c) => (c / 255) ** 2.2)
            : FALLBACK_COLOR.map((c, i) => c / BLADE_TINT[i]);
        const ground = soil.map((c, i) => c * BLADE_TINT[i]);
        // Thin blades shimmer once they are a pixel wide; the sparse far field gets wider ones.
        const widthScale = 1 + Math.max(0, distance - DENSE_DISTANCE) / 20;
        for (let i = 0; i < count; i++) {
            const h = hashTile(tileX + i * 7919, tileY - i * 104729, level ^ 0x5bd1e995);
            const h2 = hashTile(tileY + i * 6271, tileX, level ^ 0x2545f491);
            // Most blades gather round a few clump centres; every fourth fills the gaps.
            let x: number, z: number;
            if ((i & 3) === 3) {
                x = tileX + unit(h, 0);
                z = tileY + unit(h, 8);
            } else {
                const clump = hashTile(tileX, tileY, level * 31 + (i % CLUMPS_PER_TILE));
                x = tileX + 0.15 + unit(clump, 0) * 0.7 + (unit(h, 0) + unit(h, 8) - 1) * 0.2;
                z = tileY + 0.15 + unit(clump, 8) * 0.7 + (unit(h, 16) + unit(h2, 0) - 1) * 0.2;
            }
            const height = 0.07 + unit(h, 24) * unit(h2, 8) * 0.17 + unit(tileHash, (i % CLUMPS_PER_TILE) * 8) * 0.04;
            // Never wider than a tenth of the height: short, wide blades read as dark spikes.
            const halfWidth = Math.min((0.008 + unit(h2, 16) * 0.007) * widthScale, height * 0.1);
            const facing = unit(h2, 24) * Math.PI;
            const leanAngle = unit(h, 16) * Math.PI * 2;
            const lean = 0.015 + unit(h2, 8) * 0.05;
            const groundY = map.sampleHeightAtExactPlane(x, z, level);
            const shade = 0.75 + unit(h, 8) * 0.4;
            const dry = unit(h2, 0) < 0.2 ? unit(h, 24) * 0.35 : 0;
            const tip = ground.map((c, k) => (c * (1 - dry) + DRY_TIP[k] * dry) * shade * 1.15);
            // The root takes the ground's own colour so the blade grows out of it, not off it.
            const base = soil.map((c) => c * 0.8);
            const sideX = Math.cos(facing) * halfWidth;
            const sideZ = Math.sin(facing) * halfWidth;
            const phase = unit(h2, 16) * Math.PI * 2;
            const rank = (i + 0.5) / BLADES_PER_TILE;
            // World up is -Y: the tip sits `height` above the root, leaning away from it.
            this.pushVertex(x, groundY, z, -sideX, 0, -sideZ, phase, 0, rank, base);
            this.pushVertex(x, groundY, z, sideX, 0, sideZ, phase, 0, rank, base);
            this.pushVertex(x, groundY, z, Math.cos(leanAngle) * lean, -height, Math.sin(leanAngle) * lean, phase, 1, rank, tip);
        }
    }

    private pushVertex(
        x: number, y: number, z: number,
        offsetX: number, offsetY: number, offsetZ: number,
        phase: number, tip: number, rank: number,
        color: readonly number[],
    ): void {
        const i = this.floats;
        const data = this.vertices;
        data[i] = x;
        data[i + 1] = y;
        data[i + 2] = z;
        data[i + 3] = offsetX;
        data[i + 4] = offsetY;
        data[i + 5] = offsetZ;
        data[i + 6] = phase;
        data[i + 7] = tip;
        data[i + 8] = rank;
        data[i + 9] = color[0];
        data[i + 10] = color[1];
        data[i + 11] = color[2];
        this.floats = i + FLOATS_PER_VERTEX;
    }

    private upload(): void {
        const usedBytes = this.floats * 4;
        if (usedBytes === 0) return;
        if (!this.vertexBuffer || this.vertexCapacity < usedBytes) {
            this.vertexBuffer?.destroy();
            const size = Math.max(4096, Math.ceil(usedBytes / 4096) * 4096);
            this.vertexBuffer = this.device.createBuffer({
                label: "hd-clutter vertices",
                size,
                usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
            });
            this.vertexCapacity = size;
        }
        this.device.queue.writeBuffer(
            this.vertexBuffer,
            0,
            this.vertices.buffer,
            this.vertices.byteOffset,
            usedBytes,
        );
    }
}
