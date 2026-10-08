/**
 * WGSL for the stage-4 in-world overlays. Four modules:
 *  - SCREEN_OVERLAY_WGSL: pixel-space textured quads (hitsplats, health bars, overhead
 *    text/prayer, ground labels, tile text, click cross). Mirrors the WebGL
 *    hitsplat/screen programs: `fragColor = texel * u_tint`, SRC_ALPHA blending.
 *  - WORLD_OVERLAY_WGSL: world-space coloured geometry for tile markers (fills as
 *    triangle-list, outlines as line-strip), depth tested, no depth writes.
 *  - HIGHLIGHT_MASK_WGSL: flat-shaded triangles into the interact-highlight mask target.
 *  - HIGHLIGHT_COMPOSE_WGSL: multi-ring blur composite of that mask (port of
 *    InteractHighlightOverlay's compose pass).
 */

export const SCREEN_OVERLAY_WGSL = `
struct ScreenUniforms {
    u_resolution: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> screen: ScreenUniforms;
@group(1) @binding(0) var u_sprite: texture_2d<f32>;
@group(1) @binding(1) var u_sampler: sampler;

struct ScreenOut {
    @builtin(position) position: vec4<f32>,
    @location(0) v_uv: vec2<f32>,
    @location(1) v_tint: vec4<f32>,
};

@vertex
fn vs_overlay(
    @location(0) a_position: vec2<f32>,
    @location(1) a_texCoord: vec2<f32>,
    @location(2) a_tint: vec4<f32>,
) -> ScreenOut {
    var out: ScreenOut;
    // Pixel space (top-left origin) to clip space; -Y flip matches the WebGL screens.
    let ndc = a_position / screen.u_resolution * 2.0 - 1.0;
    out.position = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
    out.v_uv = a_texCoord;
    out.v_tint = a_tint;
    return out;
}

@fragment
fn fs_overlay(in: ScreenOut) -> @location(0) vec4<f32> {
    let texel = textureSample(u_sprite, u_sampler, in.v_uv);
    return vec4<f32>(texel.rgb * in.v_tint.rgb, texel.a * in.v_tint.a);
}
`;

export const WORLD_OVERLAY_WGSL = `
struct SceneMatrices {
    u_viewProjMatrix: mat4x4<f32>,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> scene: SceneMatrices;

struct WorldOut {
    @builtin(position) position: vec4<f32>,
    @location(0) v_color: vec4<f32>,
};

@vertex
fn vs_world(
    @location(0) a_position: vec3<f32>,
    @location(1) a_color: vec4<f32>,
) -> WorldOut {
    var out: WorldOut;
    let viewPos = scene.u_viewMatrix * vec4<f32>(a_position, 1.0);
    let clip = scene.u_projectionMatrix * viewPos;
    // gl-matrix clip coords are GL-style (z in [-w, w]); WebGPU wants [0, w].
    out.position = vec4<f32>(clip.x, clip.y, (clip.z + clip.w) * 0.5, clip.w);
    out.v_color = a_color;
    return out;
}

@fragment
fn fs_world(in: WorldOut) -> @location(0) vec4<f32> {
    return in.v_color;
}
`;

export const HIGHLIGHT_MASK_WGSL = `
struct SceneMatrices {
    u_viewProjMatrix: mat4x4<f32>,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> scene: SceneMatrices;

struct EntityTransform {
    u_worldEntityTransform: mat4x4<f32>,
};

@group(1) @binding(0) var<uniform> entity: EntityTransform;

@vertex
fn vs_mask(@location(0) a_position: vec3<f32>) -> @builtin(position) vec4<f32> {
    // Mirrors InteractHighlightOverlay's MASK_VERT_SRC: view-space bobbing transform then
    // projection.
    let viewPos = entity.u_worldEntityTransform * (scene.u_viewMatrix * vec4<f32>(a_position, 1.0));
    let clip = scene.u_projectionMatrix * viewPos;
    return vec4<f32>(clip.x, clip.y, (clip.z + clip.w) * 0.5, clip.w);
}

@fragment
fn fs_mask() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;

export const HIGHLIGHT_COMPOSE_WGSL = `
struct ComposeUniforms {
    u_color: vec4<f32>,
    u_texelSize: vec2<f32>,
    u_outlineRadius: f32,
    _pad: f32,
};

@group(0) @binding(0) var u_mask: texture_2d<f32>;
@group(0) @binding(1) var u_maskSampler: sampler;
@group(0) @binding(2) var<uniform> compose: ComposeUniforms;

struct ComposeOut {
    @builtin(position) position: vec4<f32>,
    @location(0) v_uv: vec2<f32>,
};

@vertex
fn vs_compose(@location(0) a_position: vec2<f32>) -> ComposeOut {
    var out: ComposeOut;
    out.position = vec4<f32>(a_position, 0.0, 1.0);
    // WebGPU render targets have their V origin at the top row (NDC +Y maps to row 0),
    // so sample the mask with V measured from the top; GL's bottom-left origin needs
    // the inverted mapping.
    out.v_uv = vec2<f32>(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
    return out;
}

fn ringAverage(stepPx: vec2<f32>, uv: vec2<f32>) -> f32 {
    var sum = 0.0;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(-stepPx.x, -stepPx.y)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(0.0, -stepPx.y)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(stepPx.x, -stepPx.y)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(-stepPx.x, 0.0)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(stepPx.x, 0.0)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(-stepPx.x, stepPx.y)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(0.0, stepPx.y)).a;
    sum += textureSample(u_mask, u_maskSampler, uv + vec2<f32>(stepPx.x, stepPx.y)).a;
    return sum * 0.125;
}

@fragment
fn fs_compose(in: ComposeOut) -> @location(0) vec4<f32> {
    let center = textureSample(u_mask, u_maskSampler, in.v_uv).a;
    let stepA = compose.u_texelSize * compose.u_outlineRadius;
    let stepB = compose.u_texelSize * (compose.u_outlineRadius * 2.0);
    let stepC = compose.u_texelSize * (compose.u_outlineRadius * 3.0);

    let ringA = ringAverage(stepA, in.v_uv);
    let ringB = ringAverage(stepB, in.v_uv);
    let ringC = ringAverage(stepC, in.v_uv);
    let blur = ringA * 0.42 + ringB * 0.36 + ringC * 0.22;

    let outside = max(1.0 - center, 0.0);
    var edge = blur * outside;
    edge = smoothstep(0.005, 0.34, edge);
    if (edge <= 0.001) {
        discard;
    }
    return vec4<f32>(compose.u_color.rgb, compose.u_color.a * edge);
}
`;
