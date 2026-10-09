/**
 * WGSL for hd-tonemap.ts, the final composite of 117 HD's HDR chain: AO, bloom, exposure, the
 * ACES filmic tonemap (Narkowicz), the 117HD grade and the display gamma encode, read from the
 * linear rgba16float scene and written to the swapchain. Fullscreen triangle, no vertex buffer.
 *
 * The uv derives from @builtin(position) and u_screen; WebGPU textures and the framebuffer
 * share the top-left origin, so it is not flipped. The canvas is non-sRGB, so the encode is an
 * explicit pow(c, 1/2.2).
 */

export const HD_TONEMAP_WGSL = `
struct TonemapUniforms {
    u_grade: vec4<f32>,   // exposure, saturation, contrast, bloomStrength
    u_ao: vec4<f32>,      // x=aoStrength, y=1 for the ACES tonemap (0: clip), zw unused
    u_screen: vec4<f32>,  // width, height, 1/width, 1/height
};

@group(0) @binding(0) var<uniform> u_tonemap: TonemapUniforms;
@group(1) @binding(0) var u_scene: texture_2d<f32>;
@group(1) @binding(1) var u_bloom: texture_2d<f32>;
@group(1) @binding(2) var u_ao: texture_2d<f32>;
@group(1) @binding(3) var u_sampler: sampler;

@vertex
fn vs_fullscreen(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

fn acesFilmic(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
    let u_grade = u_tonemap.u_grade;
    let u_aoParams = u_tonemap.u_ao;
    let u_screen = u_tonemap.u_screen;
    // WebGPU textures and the framebuffer share the top-left origin, so no y flip.
    let uv = vec2<f32>(pixel.x * u_screen.z, pixel.y * u_screen.w);

    var color = textureSampleLevel(u_scene, u_sampler, uv, 0.0).rgb;
    let ao = textureSampleLevel(u_ao, u_sampler, uv, 0.0).r;
    color *= mix(1.0, ao, u_aoParams.x);
    let bloom = textureSampleLevel(u_bloom, u_sampler, uv, 0.0).rgb;
    color += bloom * u_grade.w;
    color *= u_grade.x;
    color = select(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), acesFilmic(color), u_aoParams.y > 0.5);
    let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    color = mix(vec3<f32>(luma), color, u_grade.y);
    color = (color - 0.5) * u_grade.z + 0.5;
    return vec4<f32>(pow(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)), 1.0);
}
`;
