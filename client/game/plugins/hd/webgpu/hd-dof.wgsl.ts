/**
 * WGSL for hd-dof.ts: one fullscreen-triangle vertex plus the depth-of-field fragment of the
 * 117 HD WebGPU HDR post chain, recorded between bloom and tonemap when the follow camera is
 * zoomed in.
 *
 * fs_dof reconstructs view positions from the scene depth32float texture (non-reverse [0,1]
 * NDC, gl-matrix view space: camera at the origin looking down -Z, 1 unit = 1 tile) with the
 * inverse projection, exactly like hd-ssao.wgsl.ts. dofUv converts a top-left framebuffer pixel
 * to the y-up convention the projection expects (NDC y=+1 is the framebuffer's top row); the
 * scene colour itself is sampled in top-left uv space, no flip (hd-bloom convention).
 *
 * The circle of confusion is abs(viewZ - focusDistance) * strength, capped at maxRadiusPx. A tap
 * only blurs the centre if the tap itself is out of focus too: its weight is its own CoC clamped
 * to the centre's, so a sharp foreground edge (tap CoC ~ 0) never smears into a blurred centre.
 */

export const HD_DOF_WGSL = `
struct DofUniforms {
    u_invProj: mat4x4<f32>, // inverse of the camera projection matrix (GL-style clip)
    u_params: vec4<f32>,    // x=focus distance (view tiles), y=strength (px per tile), z=max radius px, w=unused
    u_screen: vec4<f32>,    // width, height, 1/width, 1/height (scene and depth size)
};

@group(0) @binding(0) var<uniform> u_dof: DofUniforms;
@group(1) @binding(0) var t_scene: texture_2d<f32>;
@group(1) @binding(1) var s_scene: sampler;
@group(1) @binding(2) var t_depth: texture_depth_2d;

@vertex
fn vs_fullscreen(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

fn dofUv(pixel: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(pixel.x * u_dof.u_screen.z, 1.0 - pixel.y * u_dof.u_screen.w);
}

fn dofViewPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - vec2<f32>(1.0, 1.0), depth * 2.0 - 1.0, 1.0);
    let v = u_dof.u_invProj * ndc;
    return v.xyz / v.w;
}

// Blur radius in pixels for a scene pixel: 0 at the focal plane, strength px per tile of
// defocus, capped at maxRadiusPx. The cleared sky (depth 1) is treated as furthest background.
fn dofCocPixels(pixel: vec2<f32>) -> f32 {
    let depth = textureLoad(t_depth, vec2<i32>(floor(pixel)), 0);
    if (depth >= 0.9999) {
        return u_dof.u_params.z;
    }
    let viewPos = dofViewPosition(dofUv(pixel), depth);
    let viewZ = -viewPos.z;
    return min(abs(viewZ - u_dof.u_params.x) * u_dof.u_params.y, u_dof.u_params.z);
}

@fragment
fn fs_dof(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
    let center = pixel.xy;
    let centerColor = textureSampleLevel(t_scene, s_scene, center * u_dof.u_screen.zw, 0.0).rgb;
    let centerCoc = dofCocPixels(center);
    // A sharp centre keeps its pixel untouched, so out-of-focus neighbours never bleed onto it.
    if (centerCoc < 0.5) {
        return vec4<f32>(centerColor, 1.0);
    }

    var sum = centerColor;
    var weightSum = 1.0;
    for (var i = 0; i < 12; i++) {
        let angle = f32(i) * 2.3999632;
        let radius = centerCoc * (f32(i) + 0.5) / 12.0;
        let samplePixel = clamp(
            center + vec2<f32>(cos(angle), sin(angle)) * radius,
            vec2<f32>(0.0),
            u_dof.u_screen.xy - vec2<f32>(1.0),
        );
        let sampleCoc = dofCocPixels(samplePixel);
        let weight = min(sampleCoc, centerCoc) / centerCoc;
        sum += textureSampleLevel(
            t_scene,
            s_scene,
            samplePixel * u_dof.u_screen.zw,
            0.0,
        ).rgb * weight;
        weightSum += weight;
    }
    return vec4<f32>(sum / weightSum, 1.0);
}
`;
