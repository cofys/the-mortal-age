/**
 * 117 HD's WebGPU HDR composite: applies AO, adds bloom, exposure, the ACES filmic tonemap
 * (Narkowicz), the 117HD grade and the display gamma encode to the linear rgba16float scene,
 * writing the canvas. Replaces the old per-surface grade (hd-lighting.wgsl) that clipped.
 *
 * Missing bloom/AO views fall back to 1x1 black/white textures so the composite still runs; the
 * scene/bloom/ao views change per frame, so the source bind group is rebuilt per encode.
 */
import { GPU_BUFFER_USAGE, GPU_SHADER_STAGE, GPU_TEXTURE_USAGE } from "../../../../render/webgpu/bindings";
import { HD_TONEMAP_WGSL } from "./hd-tonemap.wgsl";

const UNIFORM_FLOATS = 12;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const EXPOSURE = 0.6;
const SATURATION = 1.12;
const CONTRAST = 1.0;
const BLOOM_STRENGTH = 0.35;
const AO_STRENGTH = 0.75;
const FULLSCREEN_VERTICES = 3;
const FRAGMENT_STAGE = GPU_SHADER_STAGE.FRAGMENT;

export class HdTonemapPass {
    private readonly device: GPUDevice;
    private readonly pipeline: GPURenderPipeline;
    private readonly uniformBuffer: GPUBuffer;
    private readonly uniformBindGroup: GPUBindGroup;
    private readonly textureLayout: GPUBindGroupLayout;
    private readonly sampler: GPUSampler;
    private readonly blackTexture: GPUTexture;
    private readonly blackView: GPUTextureView;
    private readonly aoFallbackTexture: GPUTexture;
    private readonly aoFallbackView: GPUTextureView;
    private readonly uniforms = new Float32Array(UNIFORM_FLOATS);
    private disposed = false;

    constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
        this.device = device;
        const module = device.createShaderModule({ code: HD_TONEMAP_WGSL, label: "hd-tonemap" });

        const uniformLayout = device.createBindGroupLayout({
            label: "hd-tonemap uniform layout",
            entries: [
                {
                    binding: 0,
                    visibility: FRAGMENT_STAGE,
                    buffer: { type: "uniform", minBindingSize: UNIFORM_BYTES },
                },
            ],
        });
        this.textureLayout = device.createBindGroupLayout({
            label: "hd-tonemap source layout",
            entries: [
                {
                    binding: 0,
                    visibility: FRAGMENT_STAGE,
                    texture: { sampleType: "float", viewDimension: "2d" },
                },
                {
                    binding: 1,
                    visibility: FRAGMENT_STAGE,
                    texture: { sampleType: "float", viewDimension: "2d" },
                },
                {
                    binding: 2,
                    visibility: FRAGMENT_STAGE,
                    texture: { sampleType: "float", viewDimension: "2d" },
                },
                { binding: 3, visibility: FRAGMENT_STAGE, sampler: { type: "filtering" } },
            ],
        });
        this.pipeline = device.createRenderPipeline({
            label: "hd-tonemap",
            layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, this.textureLayout] }),
            vertex: { module, entryPoint: "vs_fullscreen" },
            fragment: { module, entryPoint: "fs_main", targets: [{ format: canvasFormat }] },
            primitive: { topology: "triangle-list", cullMode: "none" },
        });

        this.uniformBuffer = device.createBuffer({
            label: "hd-tonemap uniforms",
            size: UNIFORM_BYTES,
            usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
        });
        this.uniformBindGroup = device.createBindGroup({
            label: "hd-tonemap uniform bind group",
            layout: uniformLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_BYTES } }],
        });
        this.sampler = device.createSampler({
            label: "hd-tonemap sampler",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            magFilter: "linear",
            minFilter: "linear",
        });

        // Missing views: black adds nothing to scene/bloom, white AO is a no-op (mix(1, 1, x)).
        this.blackTexture = device.createTexture({
            label: "hd-tonemap black fallback",
            size: [1, 1],
            format: "rgba16float",
            usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING,
        });
        this.blackView = this.blackTexture.createView();
        this.aoFallbackTexture = device.createTexture({
            label: "hd-tonemap ao fallback",
            size: [1, 1],
            format: "r8unorm",
            usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.aoFallbackTexture },
            new Uint8Array([255]),
            { bytesPerRow: 1, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
        this.aoFallbackView = this.aoFallbackTexture.createView();
    }

    /** Records the composite pass into canvasView. bloomView/aoView are optional fallbacks. */
    encode(
        encoder: GPUCommandEncoder,
        canvasView: GPUTextureView,
        sceneView: GPUTextureView,
        bloomView: GPUTextureView | undefined,
        aoView: GPUTextureView | undefined,
        width: number,
        height: number,
        hdr = true,
    ): void {
        if (this.disposed) return;
        const uniforms = this.uniforms;
        // EXPOSURE is tuned for ACES; without it the scene is shown as rendered, clipped at 1.
        uniforms[0] = hdr ? EXPOSURE : 1;
        uniforms[1] = SATURATION;
        uniforms[2] = CONTRAST;
        uniforms[3] = BLOOM_STRENGTH;
        uniforms[4] = AO_STRENGTH;
        uniforms[5] = hdr ? 1 : 0;
        uniforms[6] = 0;
        uniforms[7] = 0;
        uniforms[8] = width;
        uniforms[9] = height;
        uniforms[10] = 1 / Math.max(1, width);
        uniforms[11] = 1 / Math.max(1, height);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        const sourceBindGroup = this.device.createBindGroup({
            label: "hd-tonemap source bind group",
            layout: this.textureLayout,
            entries: [
                { binding: 0, resource: sceneView },
                { binding: 1, resource: bloomView ?? this.blackView },
                { binding: 2, resource: aoView ?? this.aoFallbackView },
                { binding: 3, resource: this.sampler },
            ],
        });

        const pass = encoder.beginRenderPass({
            label: "hd-tonemap",
            colorAttachments: [
                {
                    view: canvasView,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.uniformBindGroup);
        pass.setBindGroup(1, sourceBindGroup);
        pass.draw(FULLSCREEN_VERTICES);
        pass.end();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.uniformBuffer.destroy();
        this.blackTexture.destroy();
        this.aoFallbackTexture.destroy();
        (this.sampler as GPUSampler & { destroy?(): void }).destroy?.();
    }
}
