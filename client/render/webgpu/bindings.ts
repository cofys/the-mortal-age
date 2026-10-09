/**
 * Frozen bind group layout for the WebGPU main world pass. Must stay in lockstep with
 * client/render/webgpu/shaders/index.ts and docs/webgpu-renderer.md.
 *
 * group(0) SceneUniforms uniform        264 bytes, see SCENE_UNIFORM_FLOATS
 * group(1) world textures               u_textures, u_textureMaterials, u_waterTextures,
 *                                       u_heightMap, u_waterMask, filtering sampler; a scene
 *                                       extension's pipelines also get its bindings from 6
 * group(2) MapUniforms dynamic uniform  per draw range, MAP_UNIFORM_STRIDE-byte stride
 * group(3) map textures                 u_modelInfoTexture, u_heightMap, u_waterMask,
 *                                       u_mapGroundMaterial
 *
 * Chrome's adapter caps maxBindGroups at 4, so a scene extension's resources (sceneExtension.ts)
 * extend group(1) instead of taking a fifth group; only its pipelines use the extended layout.
 */
export const SCENE_GROUP = 0;
export const WORLD_TEXTURES_GROUP = 1;
export const MAP_UNIFORMS_GROUP = 2;
export const MAP_TEXTURES_GROUP = 3;

/** SceneUniforms: 3 mat4 + 2 vec4 + 2 vec2 + 6 floats = 66 floats = 264 bytes. */
export const SCENE_UNIFORM_FLOATS = 66;

/**
 * Depth attachment of the world pass. depth32float (not depth24plus) so scene extensions can
 * bind it as a sampleable depth texture (SSAO); all world/actor/overlay pipelines that use the
 * scene depth must compile against it.
 */
export const SCENE_DEPTH_FORMAT: GPUTextureFormat = "depth32float";

/** MapUniforms: mat4 + vec2 + 2 f32/i32 + 4 f32/u32 = 96 bytes, padded to one alignment. */
export const MAP_UNIFORM_STRIDE = 256;
export const MAP_UNIFORM_FLOATS = 24;

export const WORLD_TEXTURE_BINDINGS = {
    textures: 0,
    materials: 1,
    waterTextures: 2,
    heightMap: 3,
    waterMask: 4,
    sampler: 5,
} as const;

export const MAP_TEXTURE_BINDINGS = {
    modelInfo: 0,
    heightMap: 1,
    waterMask: 2,
    groundMaterial: 3,
} as const;

/**
 * Draw ranges (`DrawRange = [offset, elements, instances]`) hold the offset in **index-buffer
 * bytes** (PicoGL passes it straight to drawElementsInstanced). WebGPU `drawIndexed` wants a
 * first-index, so divide by 4 (indices are Uint32).
 */
export const DRAW_RANGE_INDEX_BYTES = 4;

/**
 * TypeScript 6's DOM lib ships WebGPU interfaces but not the constant namespaces
 * (`GPUTextureUsage.RENDER_ATTACHMENT`, `GPUBufferUsage.VERTEX`, ...), so keep the numeric
 * values here instead of adding @webgpu/types on top of duplicate declarations.
 */
export const GPU_TEXTURE_USAGE = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
} as const;

export const GPU_BUFFER_USAGE = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
} as const;

export const GPU_SHADER_STAGE = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
} as const;

export const GPU_MAP_MODE = {
    READ: 0x1,
    WRITE: 0x2,
} as const;
