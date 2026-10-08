/**
 * WGSL port of ../hd-lighting.glsl (117HD non-water lighting) for the WebGPU scene extension.
 *
 * The HD resources extend the core's group(1) from SCENE_EXTENSION_FIRST_BINDING (6): HdUniforms,
 * the material lookup, the HD texture array and the depth32float shadow map. The shadow map has
 * no sampler (a depth texture cannot share group(1)'s filtering sampler), so hdShadow() takes its
 * 9 taps with textureLoad, matching the GLSL PCF and CLAMP_TO_EDGE reads.
 */

export const HD_BINDINGS_WGSL = `
struct HdUniforms {
    u_hdInverseView: mat4x4<f32>,
    u_hdShadowMatrix: mat4x4<f32>,
    u_hdLightDirection: vec4<f32>,
    u_hdAmbient: vec4<f32>,
    u_hdDirectional: vec4<f32>,
    u_hdFogColor: vec4<f32>,
    u_hdFog: vec4<f32>,          // depth, scale, draw distance in tiles
    u_hdGroundFog: vec4<f32>,    // start, end, opacity
    u_hdGrading: vec4<f32>,      // saturation, contrast, brightness, rim
    u_hdSpecular: f32,
    u_hdShadowStrength: f32,
    u_hdLightCount: i32,
    u_hdEnabled: f32,
    u_hdLightPositions: array<vec4<f32>, 16>,
    u_hdLightColors: array<vec4<f32>, 16>,
};

@group(1) @binding(6) var<uniform> hd: HdUniforms;
@group(1) @binding(7) var u_hdMaterials: texture_2d<f32>;
@group(1) @binding(8) var u_hdTextures: texture_2d_array<f32>;
@group(1) @binding(9) var u_hdShadowMap: texture_depth_2d;
`;

export const HD_LIGHTING_WGSL = `
fn hdSaturation(color: vec3<f32>, amount: f32) -> vec3<f32> {
    return mix(vec3<f32>(dot(color, vec3<f32>(0.299, 0.587, 0.114))), color, amount);
}

fn hdFogAmount(position: vec2<f32>) -> f32 {
    let depth = clamp(hd.u_hdFog.x / 5.0, 0.0, 1.0);
    if (depth <= 0.0002) {
        return 0.0;
    }
    let scale = clamp(hd.u_hdFog.y, 0.0, 16.0);
    let distance = hd.u_hdFog.z;
    let delta = abs(position - scene.u_playerPos);
    let squareDist = max(delta.x, delta.y);
    let reach = clamp((scale - 1.0) / 15.0, 0.0, 1.0);
    let rimWidth = max(8.0, distance * 0.18) * mix(1.0, 3.0, reach);
    let rim = pow(smoothstep(distance - rimWidth, distance, squareDist), mix(0.72, 0.42, depth));
    let wallBand = max(3.0, distance * 0.06) * mix(1.0, 2.0, reach);
    let wall = 1.0 - smoothstep(0.0, wallBand, distance - squareDist);
    let nearAttenuation = smoothstep(0.0, distance * mix(0.18, 0.34, reach), squareDist);
    return clamp((rim * (1.0 + 0.55 * depth) + wall * (0.9 + 0.5 * depth)) * scale * pow(depth, 0.55) * 1.25 * nearAttenuation, 0.0, 1.0);
}

fn hdShadow(position: vec3<f32>, normal: vec3<f32>) -> f32 {
    let projected = hd.u_hdShadowMatrix * vec4<f32>(position, 1.0);
    let p = projected.xyz / projected.w * 0.5 + 0.5;
    if (hd.u_hdShadowStrength == 0.0 || any(p < vec3<f32>(0.0)) || any(p > vec3<f32>(1.0))) {
        return 1.0;
    }
    let bias = max(0.0006 * (1.0 - max(dot(normal, hd.u_hdLightDirection.xyz), 0.0)), 0.00018);
    let size = vec2<i32>(textureDimensions(u_hdShadowMap, 0));
    // GL texture rows start at NDC y = -1, WebGPU's at y = +1: flip v or every shadow is
    // mirrored across the player-centred shadow map.
    let base = vec2<i32>(vec2<f32>(p.x, 1.0 - p.y) * vec2<f32>(size));
    var shadow = 0.0;
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            // textureLoad takes integer texel coords; clamp to match the GLSL sampler's
            // CLAMP_TO_EDGE instead of the zero an out-of-bounds load returns.
            let coord = clamp(base + vec2<i32>(x, y), vec2<i32>(0), size - vec2<i32>(1));
            let depth = textureLoad(u_hdShadowMap, coord, 0);
            if (p.z - bias > depth) {
                shadow += 1.0;
            }
        }
    }
    let edge = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
    return 1.0 - shadow / 9.0 * hd.u_hdShadowStrength * smoothstep(0.0, 0.05, edge);
}

fn hdMappedNormal(
    normal: vec3<f32>,
    uv: vec2<f32>,
    layer: f32,
    dx: vec3<f32>,
    dy: vec3<f32>,
    ux: vec2<f32>,
    uy: vec2<f32>,
) -> vec3<f32> {
    let determinant = ux.x * uy.y - ux.y * uy.x;
    if (abs(determinant) < 1e-8) {
        return normal;
    }
    var tangent = (dx * uy.y - dy * ux.y) / determinant;
    var bitangent = (dy * ux.x - dx * uy.x) / determinant;
    tangent -= normal * dot(normal, tangent);
    bitangent -= normal * dot(normal, bitangent);
    if (min(dot(tangent, tangent), dot(bitangent, bitangent)) < 1e-10) {
        return normal;
    }
    // 117 HD maps encode signed tangent X/Y, with an unsigned normal Z.
    var detail = textureSampleLevel(u_hdTextures, u_sampler, uv, i32(layer), 0.0).xyz;
    detail = vec3<f32>(detail.xy * 2.0 - 1.0, detail.z);
    return normalize(normalize(tangent) * detail.x + normalize(bitangent) * detail.y + normal * detail.z);
}

fn hdShade(
    surfaceIn: vec3<f32>,
    position: vec3<f32>,
    vNormal: vec3<f32>,
    material: vec4<f32>,
    metadata: vec4<f32>,
    uv: vec2<f32>,
    frontFacing: bool,
) -> vec3<f32> {
    // Derivatives must be evaluated in uniform control flow, before any material branch.
    let dx = dpdx(position);
    let dy = dpdy(position);
    let ux = dpdx(uv);
    let uy = dpdy(uv);
    if (metadata.y > 0.5) {
        return surfaceIn;
    }
    // Architecture/effects use face normals; actors and terrain interpolate
    // their own vertex normals to avoid visible triangle seams.
    var faceNormal = cross(dx, dy);
    faceNormal *= inverseSqrt(max(dot(faceNormal, faceNormal), 1e-12));
    let camera = -(scene.u_viewMatrix[3].xyz * mat3x3<f32>(
        scene.u_viewMatrix[0].xyz,
        scene.u_viewMatrix[1].xyz,
        scene.u_viewMatrix[2].xyz,
    ));
    let viewDir = normalize(camera - position);
    if (dot(faceNormal, viewDir) < 0.0) {
        faceNormal = -faceNormal;
    }
    var normal = faceNormal;
    if (dot(vNormal, vNormal) > 1e-8) {
        normal = normalize(vNormal);
        // A smooth normal may point past the camera at a visible silhouette.
        // Flipping there makes lighting jump; orient using triangle facing.
        if (!frontFacing) {
            normal = -normal;
        }
    }
    let shadow = hdShadow(position, faceNormal);
    if (metadata.x > 0.0 && metadata.z > 0.0) {
        normal = hdMappedNormal(normal, uv, metadata.z, dx, dy, ux, uy);
    }
    let base = pow(max(surfaceIn, vec3<f32>(0.0)), vec3<f32>(2.2));
    let diffuse = max(dot(normal, hd.u_hdLightDirection.xyz), 0.0);
    var pointLight = vec3<f32>(0.0);
    for (var i = 0; i < 16; i++) {
        if (i >= hd.u_hdLightCount) {
            break;
        }
        let delta = hd.u_hdLightPositions[i].xyz - position;
        let radius = hd.u_hdLightPositions[i].w;
        let distanceSquared = dot(delta, delta);
        // Most fragments lie outside each local light's radius.
        if (distanceSquared >= radius * radius) {
            continue;
        }
        let distance = max(sqrt(distanceSquared), 0.001);
        let attenuation = max(1.0 - distance / radius, 0.0);
        pointLight += hd.u_hdLightColors[i].rgb * hd.u_hdLightColors[i].w * attenuation * attenuation * max(dot(normal, delta / distance), 0.0);
    }
    pointLight *= 1.1;
    let baseLuma = dot(base, vec3<f32>(0.2126, 0.7152, 0.0722));
    let additiveFloor = mix(0.035, 0.085, smoothstep(0.10, 0.45, baseLuma));
    var color = base * (hd.u_hdAmbient.xyz + hd.u_hdDirectional.xyz * diffuse * shadow + pointLight) + pointLight * additiveFloor;
    // Upstream gloss is a Phong exponent. A half-vector here spreads the
    // highlight across roofs and terrain, making dry materials look wet.
    if (material.x > 0.0 && diffuse > 0.0) {
        let reflected = reflect(-hd.u_hdLightDirection.xyz, normal);
        let specular = pow(max(dot(viewDir, reflected), 0.0), max(material.y, 1.0));
        color += hd.u_hdDirectional.xyz * specular * material.x * hd.u_hdSpecular * shadow;
    }
    color += vec3<f32>(pow(1.0 - max(dot(normal, viewDir), 0.0), 2.0) * hd.u_hdGrading.w);
    color = hdSaturation(color, hd.u_hdGrading.x);
    color = (color - 0.5) * hd.u_hdGrading.y + 0.5;
    return pow(max(color * hd.u_hdGrading.z, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}
`;
