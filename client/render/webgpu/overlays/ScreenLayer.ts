import { GPU_BUFFER_USAGE, GPU_SHADER_STAGE, GPU_TEXTURE_USAGE } from "../bindings";
import { SCREEN_OVERLAY_WGSL } from "../shaders/overlay.wgsl";

const FLOATS_PER_VERTEX = 8; // pos(2) + uv(2) + tint(4)
const VERTICES_PER_QUAD = 6;
const SCREEN_UNIFORM_BYTES = 16;
const SHADER_STAGES = GPU_SHADER_STAGE.VERTEX | GPU_SHADER_STAGE.FRAGMENT;

export type ScreenTexture = {
    texture: GPUTexture;
    bindGroup: GPUBindGroup;
    width: number;
    height: number;
};

/** Top-left pixel rectangle used to narrow the scissor for a single quad. */
export type QuadClip = { x: number; y: number; width: number; height: number };

/**
 * Shared pixel-space textured-quad layer for stage-4 overlays. One pipeline, one dynamic
 * vertex buffer, per-texture bind groups and a canvas/pixel texture cache. Quads are queued
 * during `update()` and drawn by `flush()` inside the screen pass.
 */
export class ScreenLayer {
    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;

    private pipeline!: GPURenderPipeline;
    private uniformBuffer!: GPUBuffer;
    private uniformBindGroup!: GPUBindGroup;
    private textureLayout!: GPUBindGroupLayout;
    private sampler!: GPUSampler;

    private vertexBuffer?: GPUBuffer;
    private vertexCapacityBytes = 0;
    private vertexData = new Float32Array(0);
    private vertexFloats = 0;

    private readonly batches: Array<{ entry: ScreenTexture; first: number; clip?: QuadClip }> = [];
    private readonly canvasTextures = new WeakMap<HTMLCanvasElement, ScreenTexture>();
    private readonly ownedTextures: GPUTexture[] = [];
    private readonly uniformData = new Float32Array(SCREEN_UNIFORM_BYTES / 4);

    constructor(device: GPUDevice, format: GPUTextureFormat) {
        this.device = device;
        this.format = format;
    }

    init(): void {
        const device = this.device;
        const module = device.createShaderModule({ code: SCREEN_OVERLAY_WGSL, label: "overlay-screen" });

        const uniformLayout = device.createBindGroupLayout({
            label: "overlay-screen uniforms layout",
            entries: [
                {
                    binding: 0,
                    visibility: SHADER_STAGES,
                    buffer: { type: "uniform", minBindingSize: SCREEN_UNIFORM_BYTES },
                },
            ],
        });
        this.textureLayout = device.createBindGroupLayout({
            label: "overlay-screen texture layout",
            entries: [
                {
                    binding: 0,
                    visibility: SHADER_STAGES,
                    texture: { sampleType: "float", viewDimension: "2d" },
                },
                {
                    binding: 1,
                    visibility: SHADER_STAGES,
                    sampler: { type: "filtering" },
                },
            ],
        });

        this.uniformBuffer = device.createBuffer({
            label: "overlay-screen uniforms",
            size: SCREEN_UNIFORM_BYTES,
            usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
        });
        this.uniformBindGroup = device.createBindGroup({
            layout: uniformLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: SCREEN_UNIFORM_BYTES } }],
        });

        this.sampler = device.createSampler({
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            magFilter: "nearest",
            minFilter: "nearest",
        });

        this.pipeline = device.createRenderPipeline({
            label: "overlay-screen pipeline",
            layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, this.textureLayout] }),
            vertex: {
                module,
                entryPoint: "vs_overlay",
                buffers: [
                    {
                        arrayStride: FLOATS_PER_VERTEX * 4,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x2" },
                            { shaderLocation: 1, offset: 8, format: "float32x2" },
                            { shaderLocation: 2, offset: 16, format: "float32x4" },
                        ],
                    },
                ],
            },
            fragment: {
                module,
                entryPoint: "fs_overlay",
                targets: [
                    {
                        format: this.format,
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                        },
                    },
                ],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
        });
    }

    /** Clear this frame's queued quads. */
    begin(): void {
        this.vertexFloats = 0;
        this.batches.length = 0;
    }

    get queuedQuadCount(): number {
        return this.batches.length;
    }

    createPixelTexture(pixels: Uint8Array, width: number, height: number): ScreenTexture {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const texture = this.device.createTexture({
            label: "overlay-screen pixels",
            size: [w, h],
            format: "rgba8unorm",
            usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST,
        });
        // Row-pad to the WebGPU 256-byte bytesPerRow alignment when needed.
        const rowBytes = w * 4;
        const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
        const source =
            alignedRowBytes === rowBytes
                ? pixels
                : (() => {
                      const padded = new Uint8Array(alignedRowBytes * h);
                      for (let y = 0; y < h; y++) {
                          padded.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * alignedRowBytes);
                      }
                      return padded;
                  })();
        this.device.queue.writeTexture(
            { texture },
            source,
            { bytesPerRow: alignedRowBytes, rowsPerImage: h },
            { width: w, height: h, depthOrArrayLayers: 1 },
        );
        this.ownedTextures.push(texture);
        return this.wrapTexture(texture, w, h);
    }

    getCanvasTexture(canvas: HTMLCanvasElement): ScreenTexture | undefined {
        const cached = this.canvasTextures.get(canvas);
        if (cached) return cached;
        const width = canvas.width | 0;
        const height = canvas.height | 0;
        if (width <= 0 || height <= 0) return undefined;
        const texture = this.device.createTexture({
            label: "overlay-screen canvas",
            size: [width, height],
            format: "rgba8unorm",
            usage:
                GPU_TEXTURE_USAGE.TEXTURE_BINDING |
                GPU_TEXTURE_USAGE.COPY_DST |
                GPU_TEXTURE_USAGE.RENDER_ATTACHMENT,
        });
        try {
            this.device.queue.copyExternalImageToTexture(
                { source: canvas },
                { texture },
                { width, height, depthOrArrayLayers: 1 },
            );
        } catch {
            texture.destroy();
            return undefined;
        }
        this.ownedTextures.push(texture);
        const entry = this.wrapTexture(texture, width, height);
        this.canvasTextures.set(canvas, entry);
        return entry;
    }

    private wrapTexture(texture: GPUTexture, width: number, height: number): ScreenTexture {
        return {
            texture,
            width,
            height,
            bindGroup: this.device.createBindGroup({
                layout: this.textureLayout,
                entries: [
                    { binding: 0, resource: texture.createView() },
                    { binding: 1, resource: this.sampler },
                ],
            }),
        };
    }

    queueTexture(
        entry: ScreenTexture,
        x: number,
        y: number,
        width: number,
        height: number,
        u0: number = 0,
        v0: number = 0,
        u1: number = 1,
        v1: number = 1,
        r: number = 1,
        g: number = 1,
        b: number = 1,
        a: number = 1,
        clip?: QuadClip,
    ): void {
        const first = this.vertexFloats / FLOATS_PER_VERTEX;
        const requiredFloats = this.vertexFloats + VERTICES_PER_QUAD * FLOATS_PER_VERTEX;
        if (this.vertexData.length < requiredFloats) {
            let next = Math.max(1024, this.vertexData.length * 2 || 1024);
            while (next < requiredFloats) next *= 2;
            const grown = new Float32Array(next);
            grown.set(this.vertexData.subarray(0, this.vertexFloats));
            this.vertexData = grown;
        }
        const data = this.vertexData;
        let i = this.vertexFloats;
        const x1 = x + width;
        const y1 = y + height;
        // Two triangles, matching the cached quad vertex order used by the WebGL overlays.
        const push = (px: number, py: number, u: number, v: number): void => {
            data[i++] = px;
            data[i++] = py;
            data[i++] = u;
            data[i++] = v;
            data[i++] = r;
            data[i++] = g;
            data[i++] = b;
            data[i++] = a;
        };
        push(x, y, u0, v0);
        push(x, y1, u0, v1);
        push(x1, y1, u1, v1);
        push(x, y, u0, v0);
        push(x1, y1, u1, v1);
        push(x1, y, u1, v0);
        this.vertexFloats = i;
        this.batches.push({ entry, first, clip });
    }

    queueCanvas(
        canvas: HTMLCanvasElement,
        x: number,
        y: number,
        width: number,
        height: number,
        alpha: number = 1,
    ): boolean {
        const entry = this.getCanvasTexture(canvas);
        if (!entry) return false;
        this.queueTexture(entry, x, y, width, height, 0, 0, 1, 1, 1, 1, 1, alpha);
        return true;
    }

    /**
     * Draws queued quads (at most `maxBatches`) and removes them. Call repeatedly in the same
     * pass to interleave non-quad overlays (tile markers, highlight compose) in between.
     */
    flush(
        pass: GPURenderPassEncoder,
        clip?: { x: number; y: number; width: number; height: number },
        maxBatches: number = Number.POSITIVE_INFINITY,
    ): void {
        if (this.batches.length === 0) return;
        const device = this.device;

        const requested = Number.isFinite(maxBatches)
            ? Math.max(0, Math.floor(maxBatches))
            : this.batches.length;
        const batchCount = Math.min(this.batches.length, requested);
        if (batchCount === 0) return;
        const usedFloats =
            batchCount === this.batches.length
                ? this.vertexFloats
                : this.batches[batchCount].first * FLOATS_PER_VERTEX;

        this.uniformData[0] = this.canvasResolution[0];
        this.uniformData[1] = this.canvasResolution[1];
        device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

        const usedBytes = usedFloats * 4;
        if (!this.vertexBuffer || this.vertexCapacityBytes < usedBytes) {
            // No destroy(): an earlier flush in this frame's encoder may still use the old
            // buffer, and destroying it fails the submit. It is garbage-collected instead.
            const size = Math.max(4096, Math.ceil(usedBytes / 4096) * 4096);
            this.vertexBuffer = device.createBuffer({
                label: "overlay-screen vertices",
                size,
                usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
            });
            this.vertexCapacityBytes = size;
        }
        device.queue.writeBuffer(
            this.vertexBuffer,
            0,
            this.vertexData.buffer,
            this.vertexData.byteOffset,
            usedBytes,
        );

        const [resW, resH] = this.canvasResolution;
        const base = clip
            ? {
                  x: Math.max(0, Math.floor(clip.x)),
                  y: Math.max(0, Math.floor(clip.y)),
                  width: 0,
                  height: 0,
              }
            : { x: 0, y: 0, width: resW, height: resH };
        if (clip) {
            const maxW = Math.max(0, Math.min(resW, Math.ceil(clip.width)));
            const maxH = Math.max(0, Math.min(resH, Math.ceil(clip.height)));
            base.width = Math.max(0, Math.min(maxW, resW - base.x));
            base.height = Math.max(0, Math.min(maxH, resH - base.y));
            if (base.width <= 0 || base.height <= 0) return;
        }

        const applyScissor = (rect: { x: number; y: number; width: number; height: number }): void => {
            const x = Math.max(0, Math.floor(rect.x));
            const y = Math.max(0, Math.floor(rect.y));
            const w = Math.max(0, Math.min(Math.ceil(rect.width), resW - x));
            const h = Math.max(0, Math.min(Math.ceil(rect.height), resH - y));
            if (w <= 0 || h <= 0) return;
            pass.setScissorRect(Math.min(x, resW - 1), Math.min(y, resH - 1), w, h);
        };

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.uniformBindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer);

        let currentClipKey: string | undefined;
        const batches = this.batches;
        if (!clip && !batches.some((batch) => batch.clip)) {
            for (let i = 0; i < batchCount; i++) {
                const batch = batches[i];
                pass.setBindGroup(1, batch.entry.bindGroup);
                pass.draw(VERTICES_PER_QUAD, 1, batch.first, 0);
            }
            batches.splice(0, batchCount);
            return;
        }

        applyScissor(base);
        currentClipKey = `${base.x},${base.y},${base.width},${base.height}`;
        for (let i = 0; i < batchCount; i++) {
            const batch = batches[i];
            const clipRect = batch.clip
                ? {
                      x: Math.max(base.x, batch.clip.x),
                      y: Math.max(base.y, batch.clip.y),
                      width: Math.max(
                          0,
                          Math.min(base.x + base.width, batch.clip.x + batch.clip.width) -
                              Math.max(base.x, batch.clip.x),
                      ),
                      height: Math.max(
                          0,
                          Math.min(base.y + base.height, batch.clip.y + batch.clip.height) -
                              Math.max(base.y, batch.clip.y),
                      ),
                  }
                : base;
            const key = `${clipRect.x},${clipRect.y},${clipRect.width},${clipRect.height}`;
            if (key !== currentClipKey) {
                applyScissor(clipRect);
                currentClipKey = key;
            }
            pass.setBindGroup(1, batch.entry.bindGroup);
            pass.draw(VERTICES_PER_QUAD, 1, batch.first, 0);
        }
        if (!clip) {
            pass.setScissorRect(0, 0, resW, resH);
        } else {
            applyScissor(base);
        }
        batches.splice(0, batchCount);
    }

    private canvasResolution: [number, number] = [1, 1];

    setCanvasResolution(width: number, height: number): void {
        this.canvasResolution[0] = Math.max(1, width | 0);
        this.canvasResolution[1] = Math.max(1, height | 0);
    }

    /** Frees textures older than the canvas WeakMap cannot track (text caches own theirs). */
    destroy(): void {
        for (const texture of this.ownedTextures) texture.destroy();
        this.ownedTextures.length = 0;
        this.vertexBuffer?.destroy();
        this.vertexBuffer = undefined;
        this.vertexCapacityBytes = 0;
        this.uniformBuffer?.destroy();
    }

    /** Texture memory currently cached for canvases is released with the canvas itself. */
    releaseTexture(entry: ScreenTexture | undefined): void {
        if (!entry) return;
        const index = this.ownedTextures.indexOf(entry.texture);
        if (index >= 0) this.ownedTextures.splice(index, 1);
        entry.texture.destroy();
    }
}
