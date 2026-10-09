/**
 * 117 HD's WebGPU depth of field, recorded between bloom and tonemap when the follow camera is
 * zoomed in.
 *
 * encode() reconstructs view-space depth from the scene's depth32float attachment with the
 * inverse projection (hd-ssao convention), computes a circle of confusion from the distance to
 * the focal plane and gathers a 12-tap golden-angle disc of the HDR scene, writing an owned
 * rgba16float view the tonemap pass reads instead of the scene. Output stays linear HDR.
 *
 * With strength at or below STRENGTH_EPSILON the pass records nothing and hands back the scene
 * view, so the chain is unchanged when DOF is off.
 */
import { GPU_BUFFER_USAGE, GPU_SHADER_STAGE, GPU_TEXTURE_USAGE } from "../../../../render/webgpu/bindings";
import { HD_DOF_WGSL } from "./hd-dof.wgsl";

const DOF_FORMAT: GPUTextureFormat = "rgba16float";
const UNIFORM_FLOATS = 24;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const MAX_RADIUS_PX = 12;
const STRENGTH_EPSILON = 0.001;
const FULLSCREEN_VERTICES = 3;
const FRAGMENT_STAGE = GPU_SHADER_STAGE.FRAGMENT;

export class HdDepthOfFieldPass {
    private readonly device: GPUDevice;
    private readonly uniformBuffer: GPUBuffer;
    private readonly uniformBindGroup: GPUBindGroup;
    private readonly textureLayout: GPUBindGroupLayout;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly uniforms = new Float32Array(UNIFORM_FLOATS);

    private texture?: GPUTexture;
    private view?: GPUTextureView;
    private sourceBindGroup?: GPUBindGroup;
    private sceneView?: GPUTextureView;
    private depthView?: GPUTextureView;
    private width = 0;
    private height = 0;
    private disposed = false;

    constructor(device: GPUDevice) {
        this.device = device;
        const module = device.createShaderModule({ code: HD_DOF_WGSL, label: "hd-dof" });

        const uniformLayout = device.createBindGroupLayout({
            label: "hd-dof uniform layout",
            entries: [
                {
                    binding: 0,
                    visibility: FRAGMENT_STAGE,
                    buffer: { type: "uniform", minBindingSize: UNIFORM_BYTES },
                },
            ],
        });
        this.textureLayout = device.createBindGroupLayout({
            label: "hd-dof source layout",
            entries: [
                {
                    binding: 0,
                    visibility: FRAGMENT_STAGE,
                    texture: { sampleType: "float", viewDimension: "2d" },
                },
                { binding: 1, visibility: FRAGMENT_STAGE, sampler: { type: "filtering" } },
                {
                    binding: 2,
                    visibility: FRAGMENT_STAGE,
                    texture: { sampleType: "depth", viewDimension: "2d" },
                },
            ],
        });

        this.pipeline = device.createRenderPipeline({
            label: "hd-dof",
            layout: device.createPipelineLayout({
                label: "hd-dof pipeline layout",
                bindGroupLayouts: [uniformLayout, this.textureLayout],
            }),
            vertex: { module, entryPoint: "vs_fullscreen" },
            fragment: { module, entryPoint: "fs_dof", targets: [{ format: DOF_FORMAT }] },
            primitive: { topology: "triangle-list" },
        });

        this.uniformBuffer = device.createBuffer({
            label: "hd-dof uniforms",
            size: UNIFORM_BYTES,
            usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
        });
        this.uniformBindGroup = device.createBindGroup({
            label: "hd-dof uniform bind group",
            layout: uniformLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_BYTES } }],
        });
        this.sampler = device.createSampler({
            label: "hd-dof sampler",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            magFilter: "linear",
            minFilter: "linear",
        });
    }

    /** (Re)creates the blurred copy when the scene size changes. */
    ensure(width: number, height: number): void {
        if (this.disposed || width < 1 || height < 1) return;
        if (this.texture && this.width === width && this.height === height) return;
        this.texture?.destroy();
        this.width = width;
        this.height = height;
        this.texture = this.device.createTexture({
            label: "hd-dof scene",
            size: [width, height],
            format: DOF_FORMAT,
            usage: GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.TEXTURE_BINDING,
        });
        this.view = this.texture.createView();
    }

    /** Returns the view the tonemap pass should read: the blurred copy when enabled, else sceneView. */
    encode(
        encoder: GPUCommandEncoder,
        sceneView: GPUTextureView,
        depthView: GPUTextureView,
        inverseProjection: Float32Array,
        focusDistance: number,
        strength: number,
    ): GPUTextureView {
        if (this.disposed || !this.view || strength <= STRENGTH_EPSILON) return sceneView;

        if (this.sceneView !== sceneView || this.depthView !== depthView || !this.sourceBindGroup) {
            this.sourceBindGroup = this.device.createBindGroup({
                label: "hd-dof source bind group",
                layout: this.textureLayout,
                entries: [
                    { binding: 0, resource: sceneView },
                    { binding: 1, resource: this.sampler },
                    { binding: 2, resource: depthView },
                ],
            });
            this.sceneView = sceneView;
            this.depthView = depthView;
        }

        const data = this.uniforms;
        data.set(inverseProjection.subarray(0, 16), 0);
        data[16] = focusDistance;
        data[17] = strength;
        data[18] = MAX_RADIUS_PX;
        data[19] = 0;
        data[20] = this.width;
        data[21] = this.height;
        data[22] = 1 / this.width;
        data[23] = 1 / this.height;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

        const pass = encoder.beginRenderPass({
            label: "hd-dof",
            colorAttachments: [
                {
                    view: this.view,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.uniformBindGroup);
        pass.setBindGroup(1, this.sourceBindGroup!);
        pass.draw(FULLSCREEN_VERTICES);
        pass.end();
        return this.view;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.texture?.destroy();
        this.texture = undefined;
        this.view = undefined;
        this.sourceBindGroup = undefined;
        this.sceneView = undefined;
        this.depthView = undefined;
        this.uniformBuffer.destroy();
        // The DOM lib predates GPUSampler.destroy(); call it where the browser has it.
        (this.sampler as GPUSampler & { destroy?(): void }).destroy?.();
    }
}
