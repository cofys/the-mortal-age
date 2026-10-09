/**
 * 117 HD's WebGPU bloom: a 6-level rgba16float mip chain over the HDR scene colour.
 *
 * encode() prefilters the scene into level 0 (half the scene size), box-downsamples down to
 * level 5, then additively upsamples back up; it returns the level-0 view the tonemap pass adds.
 * Every level is RENDER_ATTACHMENT | TEXTURE_BINDING and sampled with a filtering sampler
 * (rgba16float is filterable in WebGPU core).
 *
 * Every pass owns a uniform buffer: queue.writeBuffer writes all land before the recorded
 * passes execute, so sharing one buffer would give every pass the last written values.
 */
import { GPU_BUFFER_USAGE, GPU_SHADER_STAGE, GPU_TEXTURE_USAGE } from "../../../../render/webgpu/bindings";
import { HD_BLOOM_WGSL } from "./hd-bloom.wgsl";

const LEVEL_COUNT = 6;
const UNIFORM_FLOATS = 12;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const BLOOM_FORMAT: GPUTextureFormat = "rgba16float";
const THRESHOLD = 0.8;
const KNEE = 0.5;
const INTENSITY = 1.0;
const FULLSCREEN_VERTICES = 3;
const FRAGMENT_STAGE = GPU_SHADER_STAGE.FRAGMENT;

type BloomLevel = {
    readonly texture: GPUTexture;
    readonly view: GPUTextureView;
    readonly width: number;
    readonly height: number;
};

type BloomPass = {
    readonly buffer: GPUBuffer;
    readonly data: Float32Array;
    readonly uniformBindGroup: GPUBindGroup;
    readonly sourceBindGroup: GPUBindGroup;
};

export class HdBloomPass {
    private readonly device: GPUDevice;
    private readonly sampler: GPUSampler;
    private readonly uniformLayout: GPUBindGroupLayout;
    private readonly textureLayout: GPUBindGroupLayout;
    private readonly pipelineLayout: GPUPipelineLayout;
    private readonly prefilterPipeline: GPURenderPipeline;
    private readonly downsamplePipeline: GPURenderPipeline;
    private readonly upsamplePipeline: GPURenderPipeline;

    private levels: BloomLevel[] = [];
    private downsamples: BloomPass[] = [];
    private upsamples: BloomPass[] = [];
    private readonly prefilterData = new Float32Array(UNIFORM_FLOATS);
    private prefilterBuffer?: GPUBuffer;
    private prefilterUniformBindGroup?: GPUBindGroup;
    private prefilterSourceBindGroup?: GPUBindGroup;
    private prefilterView?: GPUTextureView;
    private sceneWidth = 0;
    private sceneHeight = 0;
    private disposed = false;

    constructor(device: GPUDevice) {
        this.device = device;
        const module = device.createShaderModule({ code: HD_BLOOM_WGSL, label: "hd-bloom" });

        this.uniformLayout = device.createBindGroupLayout({
            label: "hd-bloom uniform layout",
            entries: [
                {
                    binding: 0,
                    visibility: FRAGMENT_STAGE,
                    buffer: { type: "uniform", minBindingSize: UNIFORM_BYTES },
                },
            ],
        });
        this.textureLayout = device.createBindGroupLayout({
            label: "hd-bloom source layout",
            entries: [
                {
                    binding: 0,
                    visibility: FRAGMENT_STAGE,
                    texture: { sampleType: "float", viewDimension: "2d" },
                },
                { binding: 1, visibility: FRAGMENT_STAGE, sampler: { type: "filtering" } },
            ],
        });
        this.pipelineLayout = device.createPipelineLayout({
            label: "hd-bloom pipeline layout",
            bindGroupLayouts: [this.uniformLayout, this.textureLayout],
        });

        const createPipeline = (entryPoint: string, additive: boolean): GPURenderPipeline =>
            device.createRenderPipeline({
                label: `hd-bloom ${entryPoint}`,
                layout: this.pipelineLayout,
                vertex: { module, entryPoint: "vs_fullscreen" },
                fragment: {
                    module,
                    entryPoint,
                    targets: [
                        {
                            format: BLOOM_FORMAT,
                            blend: additive
                                ? {
                                      color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                                      alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
                                  }
                                : undefined,
                        },
                    ],
                },
                primitive: { topology: "triangle-list" },
            });
        this.prefilterPipeline = createPipeline("fs_prefilter", false);
        this.downsamplePipeline = createPipeline("fs_downsample", false);
        this.upsamplePipeline = createPipeline("fs_upsample", true);

        this.sampler = device.createSampler({
            label: "hd-bloom sampler",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            magFilter: "linear",
            minFilter: "linear",
        });
    }

    /** (Re)creates the mip chain when the scene size changes. */
    ensure(width: number, height: number): void {
        if (this.disposed) return;
        const sceneWidth = Math.max(1, Math.floor(width));
        const sceneHeight = Math.max(1, Math.floor(height));
        if (this.sceneWidth === sceneWidth && this.sceneHeight === sceneHeight) return;
        this.destroyResources();
        this.sceneWidth = sceneWidth;
        this.sceneHeight = sceneHeight;

        const levels: BloomLevel[] = [];
        let levelWidth = Math.max(1, Math.ceil(sceneWidth / 2));
        let levelHeight = Math.max(1, Math.ceil(sceneHeight / 2));
        for (let i = 0; i < LEVEL_COUNT; i++) {
            const texture = this.device.createTexture({
                label: `hd-bloom level ${i}`,
                size: [levelWidth, levelHeight],
                format: BLOOM_FORMAT,
                usage: GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.TEXTURE_BINDING,
            });
            levels.push({ texture, view: texture.createView(), width: levelWidth, height: levelHeight });
            levelWidth = Math.max(1, Math.ceil(levelWidth / 2));
            levelHeight = Math.max(1, Math.ceil(levelHeight / 2));
        }
        this.levels = levels;

        this.prefilterBuffer = this.createUniformBuffer("hd-bloom prefilter");
        this.prefilterUniformBindGroup = this.createUniformBindGroup(this.prefilterBuffer, "hd-bloom prefilter");
        this.prefilterSourceBindGroup = undefined;
        this.prefilterView = undefined;

        this.downsamples = [];
        for (let i = 0; i < LEVEL_COUNT - 1; i++) {
            this.downsamples.push(this.createPass(levels[i], `hd-bloom downsample ${i}`));
        }
        this.upsamples = [];
        for (let i = LEVEL_COUNT - 1; i >= 1; i--) {
            this.upsamples.push(this.createPass(levels[i], `hd-bloom upsample ${i}`));
        }
    }

    /** Records threshold + downsample + additive upsample passes; returns the bloom view, or undefined if not ready. */
    encode(encoder: GPUCommandEncoder, sceneView: GPUTextureView): GPUTextureView | undefined {
        if (this.disposed || this.levels.length === 0 || !this.prefilterBuffer ||
            !this.prefilterUniformBindGroup) {
            return undefined;
        }
        const levels = this.levels;

        if (this.prefilterView !== sceneView) {
            this.prefilterSourceBindGroup = this.device.createBindGroup({
                label: "hd-bloom prefilter source",
                layout: this.textureLayout,
                entries: [
                    { binding: 0, resource: sceneView },
                    { binding: 1, resource: this.sampler },
                ],
            });
            this.prefilterView = sceneView;
        }

        this.writeUniform(this.prefilterBuffer, this.prefilterData, this.sceneWidth, this.sceneHeight, levels[0]);
        this.recordPass(
            encoder,
            this.prefilterPipeline,
            this.prefilterUniformBindGroup,
            this.prefilterSourceBindGroup!,
            levels[0],
            "clear",
        );

        for (let i = 0; i < this.downsamples.length; i++) {
            const pass = this.downsamples[i];
            this.writeUniform(pass.buffer, pass.data, levels[i].width, levels[i].height, levels[i + 1]);
            this.recordPass(encoder, this.downsamplePipeline, pass.uniformBindGroup, pass.sourceBindGroup, levels[i + 1], "clear");
        }

        for (let i = 0; i < this.upsamples.length; i++) {
            const pass = this.upsamples[i];
            const source = levels[LEVEL_COUNT - 1 - i];
            const destination = levels[LEVEL_COUNT - 2 - i];
            this.writeUniform(pass.buffer, pass.data, source.width, source.height, destination);
            this.recordPass(encoder, this.upsamplePipeline, pass.uniformBindGroup, pass.sourceBindGroup, destination, "load");
        }

        return levels[0].view;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.destroyResources();
        // The DOM lib predates GPUSampler.destroy(); call it where the browser has it.
        (this.sampler as GPUSampler & { destroy?(): void }).destroy?.();
    }

    private createUniformBuffer(label: string): GPUBuffer {
        return this.device.createBuffer({
            label,
            size: UNIFORM_BYTES,
            usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
        });
    }

    private createUniformBindGroup(buffer: GPUBuffer, label: string): GPUBindGroup {
        return this.device.createBindGroup({
            label: `${label} uniform bind group`,
            layout: this.uniformLayout,
            entries: [{ binding: 0, resource: { buffer, offset: 0, size: UNIFORM_BYTES } }],
        });
    }

    private createPass(source: BloomLevel, label: string): BloomPass {
        const buffer = this.createUniformBuffer(label);
        return {
            buffer,
            data: new Float32Array(UNIFORM_FLOATS),
            uniformBindGroup: this.createUniformBindGroup(buffer, label),
            sourceBindGroup: this.device.createBindGroup({
                label: `${label} source bind group`,
                layout: this.textureLayout,
                entries: [
                    { binding: 0, resource: source.view },
                    { binding: 1, resource: this.sampler },
                ],
            }),
        };
    }

    private writeUniform(
        buffer: GPUBuffer,
        data: Float32Array,
        sourceWidth: number,
        sourceHeight: number,
        destination: BloomLevel,
    ): void {
        data[0] = sourceWidth;
        data[1] = sourceHeight;
        data[2] = 1 / sourceWidth;
        data[3] = 1 / sourceHeight;
        data[4] = destination.width;
        data[5] = destination.height;
        data[6] = 1 / destination.width;
        data[7] = 1 / destination.height;
        data[8] = THRESHOLD;
        data[9] = KNEE;
        data[10] = INTENSITY;
        data[11] = 0;
        this.device.queue.writeBuffer(buffer, 0, data);
    }

    private recordPass(
        encoder: GPUCommandEncoder,
        pipeline: GPURenderPipeline,
        uniformBindGroup: GPUBindGroup,
        sourceBindGroup: GPUBindGroup,
        destination: BloomLevel,
        loadOp: "clear" | "load",
    ): void {
        const pass = encoder.beginRenderPass({
            label: "hd-bloom",
            colorAttachments: [
                {
                    view: destination.view,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp,
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, uniformBindGroup);
        pass.setBindGroup(1, sourceBindGroup);
        pass.draw(FULLSCREEN_VERTICES);
        pass.end();
    }

    private destroyResources(): void {
        for (const level of this.levels) level.texture.destroy();
        this.levels = [];
        for (const pass of this.downsamples) pass.buffer.destroy();
        this.downsamples = [];
        for (const pass of this.upsamples) pass.buffer.destroy();
        this.upsamples = [];
        this.prefilterBuffer?.destroy();
        this.prefilterBuffer = undefined;
        this.prefilterUniformBindGroup = undefined;
        this.prefilterSourceBindGroup = undefined;
        this.prefilterView = undefined;
        this.sceneWidth = 0;
        this.sceneHeight = 0;
    }
}
