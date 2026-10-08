/**
 * WGSL for the main world pass. Entry points and bind group layout are frozen in
 * client/render/webgpu/bindings.ts and docs/webgpu-renderer.md.
 *
 * The vertex source defines the shared bindings, uniforms, helpers and varyings; the fragment
 * source appends the water shading and the fragment entry point. `options.alpha` selects the
 * `DISCARD_ALPHA` behaviour of the WebGL mainAlphaProgram.
 */
import type { WebGPUSceneShaders } from "../sceneExtension";
import { createMainFragmentWgsl } from "./main.frag.wgsl";
import { createMainVertexWgsl } from "./main.vert.wgsl";

export interface MainShaderOptions {
    /** Adds the `DISCARD_ALPHA` behaviour of the WebGL mainAlphaProgram. */
    alpha: boolean;
    /** A scene extension's WGSL slots (../sceneExtension.ts). */
    ext?: WebGPUSceneShaders;
    /** Emits the depth entries instead of using the scene entries; needs `ext.depth`. */
    depth?: boolean;
}

export const MAIN_VERTEX_ENTRY = "vs_main";
export const MAIN_FRAGMENT_ENTRY = "fs_main";
export const MAIN_DEPTH_VERTEX_ENTRY = "vs_main_depth";
export const DEPTH_FRAGMENT_ENTRY = "fs_depth";

export function createMainShaderModule(
    device: GPUDevice,
    options: MainShaderOptions,
): GPUShaderModule {
    const depth = !!options.depth && !!options.ext?.depth;
    const code =
        createMainVertexWgsl(options.ext, depth) + "\n" +
        createMainFragmentWgsl(options.alpha, options.ext, depth);
    const base = options.alpha ? "main-alpha" : "main";
    return device.createShaderModule({
        code,
        label: `${base}${options.ext ? "-ext" : ""}${depth ? "-depth" : ""}`,
    });
}
