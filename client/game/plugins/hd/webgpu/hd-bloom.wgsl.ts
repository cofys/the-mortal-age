/**
 * WGSL for hd-bloom.ts: one fullscreen-triangle vertex plus the soft-knee prefilter, box
 * downsample and additive tent upsample fragments of the 117 HD WebGPU bloom chain.
 *
 * Every fragment derives its sample UV from @builtin(position) and the destination size in
 * u_dst. WebGPU textures and the framebuffer share the top-left origin, so the uvs are not
 * flipped; level N-1 is the upright image.
 */

export const HD_BLOOM_WGSL = `
struct BloomUniforms {
    u_src: vec4<f32>,    // src width, src height, 1/src width, 1/src height
    u_dst: vec4<f32>,    // dst width, dst height, 1/dst width, 1/dst height
    u_params: vec4<f32>, // x=threshold, y=knee, z=intensity, w=unused
};

@group(0) @binding(0) var<uniform> u_bloom: BloomUniforms;
@group(1) @binding(0) var t_src: texture_2d<f32>;
@group(1) @binding(1) var s_src: sampler;

@vertex
fn vs_fullscreen(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

// WebGPU textures and the framebuffer share the top-left origin, so no y flip.
fn bloomUv(pixel: vec4<f32>) -> vec2<f32> {
    return vec2<f32>(pixel.x / u_bloom.u_dst.x, pixel.y / u_bloom.u_dst.y);
}

// 4 taps at +-0.5 source texel: the box filter the prefilter, downsample and upsample share.
fn bloomTaps(uv: vec2<f32>) -> vec3<f32> {
    let texel = u_bloom.u_src.zw;
    var color = vec3<f32>(0.0);
    color += textureSampleLevel(t_src, s_src, uv + vec2<f32>(-0.5, -0.5) * texel, 0.0).rgb;
    color += textureSampleLevel(t_src, s_src, uv + vec2<f32>(0.5, -0.5) * texel, 0.0).rgb;
    color += textureSampleLevel(t_src, s_src, uv + vec2<f32>(-0.5, 0.5) * texel, 0.0).rgb;
    color += textureSampleLevel(t_src, s_src, uv + vec2<f32>(0.5, 0.5) * texel, 0.0).rgb;
    return color * 0.25;
}

@fragment
fn fs_prefilter(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
    let color = bloomTaps(bloomUv(pixel));
    let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    let knee = max(u_bloom.u_params.y, 1e-4);
    var soft = clamp(luma - u_bloom.u_params.x + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    let weight = max(soft, luma - u_bloom.u_params.x) / max(luma, 1e-4);
    return vec4<f32>(color * weight * u_bloom.u_params.z, 1.0);
}

@fragment
fn fs_downsample(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(bloomTaps(bloomUv(pixel)), 1.0);
}

// The destination blends one/one onto its existing content, so this only adds its taps.
@fragment
fn fs_upsample(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(bloomTaps(bloomUv(pixel)), 1.0);
}
`;
