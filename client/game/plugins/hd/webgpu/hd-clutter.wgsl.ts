/**
 * WGSL for hd-clutter.ts: the 117 HD WebGPU grass layer. group(0) is the scene uniforms;
 * group(1) carries the HD sun, ambient and fog so blades are lit and fogged like the ground.
 *
 * Every blade vertex carries its root, its offset from the root, a wind phase, a tip factor
 * (0 base, 1 tip) and a density rank. Blades thin out with distance (a blade shows while its rank
 * is under the density there) and shrink into the ground at the edge of the band, so the far edge
 * never pops and no transparency sorting is needed. World Y points down.
 */

import { hdMistWgsl } from "./hd-lighting.wgsl";

export const HD_CLUTTER_WGSL = `
struct SceneUniforms {
    u_viewProjMatrix: mat4x4<f32>,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
    u_skyColor: vec4<f32>,
    u_sceneHslOverride: vec4<f32>,
    u_cameraPos: vec2<f32>,
    u_playerPos: vec2<f32>,
    u_renderDistance: f32,
    u_fogDepth: f32,
    u_currentTime: f32,
};

struct ClutterLight {
    ambient: vec4<f32>,
    directional: vec4<f32>,
    lightDirection: vec4<f32>,
    fogColor: vec4<f32>,
    fog: vec4<f32>, // start, end (tiles), curve exponent
    mist: vec4<f32>, // HdMist.ts u_hdMist
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> light: ClutterLight;
${hdMistWgsl("light.mist")}
// Density is full up to DENSE_DISTANCE and falls to FAR_DENSITY by THIN_DISTANCE; blades then
// shrink away between SHRINK_START and SHRINK_END. Mirrored in hd-clutter.ts.
const DENSE_DISTANCE: f32 = 10.0;
const THIN_DISTANCE: f32 = 30.0;
const FAR_DENSITY: f32 = 0.2;
const SHRINK_START: f32 = 28.0;
const SHRINK_END: f32 = 36.0;
const SWAY: f32 = 0.025;

struct ClutterOut {
    @builtin(position) position: vec4<f32>,
    @location(0) v_color: vec3<f32>,
};

@vertex
fn vs_clutter(
    @location(0) a_root: vec3<f32>,
    @location(1) a_offset: vec3<f32>,
    @location(2) a_blade: vec3<f32>, // wind phase, tip factor, density rank
    @location(3) a_color: vec3<f32>,
) -> ClutterOut {
    let phase = a_blade.x;
    let tip = a_blade.y;
    let rank = a_blade.z;
    let delta = abs(a_root.xz - scene.u_playerPos);
    let dist = length(a_root.xz - scene.u_playerPos);
    let density = mix(1.0, FAR_DENSITY, smoothstep(DENSE_DISTANCE, THIN_DISTANCE, dist));
    let size = select(0.0, 1.0 - smoothstep(SHRINK_START, SHRINK_END, dist), rank < density);

    // Gusts travel across the field; each blade adds its own flutter.
    let gust = sin(scene.u_currentTime * 0.9 + a_root.x * 0.35 + a_root.z * 0.2) * 0.6 + 0.4;
    let flutter = sin(scene.u_currentTime * 2.3 + phase);
    var world = a_root + a_offset * size;
    world.x += (gust + flutter * 0.35) * tip * SWAY * size;
    world.z += (gust * 0.5 + cos(scene.u_currentTime * 1.9 + phase) * 0.3) * tip * SWAY * size;

    let clip = scene.u_projectionMatrix * (scene.u_viewMatrix * vec4<f32>(world, 1.0));

    // Lit like the ground under it (normal straight up), plus a little light through the blade.
    let up = vec3<f32>(0.0, -1.0, 0.0);
    let sun = max(dot(up, light.lightDirection.xyz), 0.0);
    var color = a_color * (light.ambient.rgb + light.directional.rgb * (sun * 0.85 + 0.15 * tip));
    let squareDist = max(delta.x, delta.y);
    let fog = pow(smoothstep(light.fog.x, light.fog.y, squareDist), light.fog.z);
    // The blades stand in the same low-lying mist as the ground, then the distance fog.
    color = mix(color, light.fogColor.rgb, hdMistAmount(world));
    color = mix(color, light.fogColor.rgb, fog);

    var out: ClutterOut;
    // gl-matrix clip coords are GL-style (z in [-w, w]); WebGPU wants [0, w].
    out.position = vec4<f32>(clip.x, clip.y, (clip.z + clip.w) * 0.5, clip.w);
    out.v_color = color;
    return out;
}

@fragment
fn fs_clutter(in: ClutterOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.v_color, 1.0);
}
`;
