/**
 * WGSL port of client/render/shaders/main.vert.glsl and the includes it pulls in:
 * multi-draw, scene-uniforms, branchless-logic, hsl-to-rgb, unpack-float, fog, material,
 * height-map and vertex.
 *
 * shaders/index.ts concatenates this source with the fragment source into one module, so the
 * bindings, SceneUniforms/MapUniforms, Material/getMaterial, VertexOutput and the shared helpers
 * declared here are also visible to the fragment entry point.
 *
 * `ext` fills the scene-extension slots (declarations, varyings, end of vs_main); see
 * ../sceneExtension.ts. `depth` appends vs_main_depth for the extension's depth pipelines.
 */
import type { WebGPUSceneShaders } from "../sceneExtension";

/**
 * Depth-pass vertex entry (scene extensions with a `depth` shader). The view-space position is
 * assembled exactly like vs_main (world-entity transform, plane/priority depth biases) and handed
 * to the extension's sceneDepthPosition. Only the varyings a cutout test needs are emitted.
 */
const DEPTH_VERTEX_WGSL = `
struct DepthVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_color: vec4<f32>,
    @location(1) v_texCoord: vec2<f32>,
    @location(2) @interpolate(flat) v_texId: u32,
};

@vertex
fn vs_main_depth(
    @location(0) a_vertex: vec3<u32>,
    @builtin(instance_index) instance_index: u32,
) -> DepthVertexOutput {
    let offset = i32(textureLoad(u_modelInfoTexture, getDataTexCoordFromIndex(getDrawId()), 0).r);

    let vertex = decodeVertex(
        a_vertex.x,
        a_vertex.y,
        a_vertex.z,
        scene.u_brightness,
        vec4<f32>(-1.0, -1.0, -1.0, 0.0),
    );

    var out: DepthVertexOutput;
    out.v_color = vertex.color;

    let material = getMaterial(vertex.textureId);
    let textureAnimation = vec2<f32>(f32(material.animU), f32(material.animV));
    if (scene.u_isNewTextureAnim > 0.5) {
        out.v_texCoord = vertex.texCoord
            + glslModVec2(glslMod(scene.u_currentTime, 128.0) * textureAnimation / 64.0, vec2<f32>(1.0));
    } else {
        out.v_texCoord = vertex.texCoord
            + (scene.u_currentTime / 0.02) * textureAnimation * TEXTURE_ANIM_UNIT;
    }
    out.v_texId = vertex.textureId;

    let modelInfo = decodeModelInfo(offset, instance_index);
    if (f32(modelInfo.planeCullLevel) > mapU.u_roofPlaneLimit + 0.5) {
        out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return out;
    }

    var localPos = vertex.pos + vec3<f32>(modelInfo.tilePos.x, 0.0, modelInfo.tilePos.y);

    let interpPos = modelInfo.tilePos * vec2<f32>(when_eq(modelInfo.contourGround, CONTOUR_GROUND_CENTER_TILE))
        + localPos.xz * vec2<f32>(when_eq(modelInfo.contourGround, CONTOUR_GROUND_VERTEX));
    localPos.y -= f32(modelInfo.height);
    if (modelInfo.contourGround < CONTOUR_GROUND_NONE) {
        localPos.y -= getHeightInterp(interpPos, modelInfo.plane);
    }

    localPos /= 128.0;
    localPos += vec3<f32>(mapU.u_mapPos.x, 0.0, mapU.u_mapPos.y) * 64.0;

    var viewPos = mapU.u_worldEntityTransform * (scene.u_viewMatrix * vec4<f32>(localPos, 1.0));
    viewPos.z += f32(modelInfo.plane) * PLANE_LAYER_EPSILON;

    let mp = modelInfo.priority & 0x7u;
    if (mp > 0u) {
        viewPos.z += f32(mp) * PRIORITY_LAYER_EPSILON;
    }
    let fp = vertex.priority & 0x7u;
    if (fp > 0u) {
        viewPos.z += f32(fp) * FACE_PRIORITY_EPSILON;
    }

    out.position = sceneDepthPosition(viewPos);
    return out;
}
`;

export function createMainVertexWgsl(ext?: WebGPUSceneShaders, depth: boolean = false): string {
    return (ext?.world.declarations ?? "") + `
// ── Bind groups (frozen layout, see client/render/webgpu/bindings.ts) ─────────────────────────

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
    u_brightness: f32,
    u_colorBanding: f32,
    u_isNewTextureAnim: f32,
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;

@group(1) @binding(0) var u_textures: texture_2d_array<f32>;
@group(1) @binding(1) var u_textureMaterials: texture_2d<u32>;
@group(1) @binding(2) var u_waterTextures: texture_2d_array<f32>;
@group(1) @binding(5) var u_sampler: sampler;

struct MapUniforms {
    u_worldEntityTransform: mat4x4<f32>,
    u_mapPos: vec2<f32>,
    u_timeLoaded: f32,
    u_sceneBorderSize: i32,
    u_worldEntityOpacity: f32,
    u_roofPlaneLimit: f32,
    u_drawId: u32,
    u_isWorldEntity: u32,
};

@group(2) @binding(0) var<uniform> mapU: MapUniforms;

@group(3) @binding(0) var u_modelInfoTexture: texture_2d<u32>;
// The main pass reads the map square's own height map / water mask (group 3), matching
// WebGLMapSquare's per-map .texture("u_heightMap"/"u_waterMask") bindings.
@group(3) @binding(1) var u_mapHeightMap: texture_2d_array<i32>;
@group(3) @binding(2) var u_mapWaterMask: texture_2d_array<f32>;

// ── Constants (main.vert.glsl, height-map.glsl, material.glsl) ────────────────────────────────

const TEXTURE_ANIM_UNIT: f32 = 1.0 / 128.0;

const CONTOUR_GROUND_CENTER_TILE: f32 = 0.0;
const CONTOUR_GROUND_VERTEX: f32 = 1.0;
const CONTOUR_GROUND_NONE: f32 = 2.0;
const FOG_CORNER_ROUNDING: f32 = 0.0;

const MATERIAL_FLAG_WATER: i32 = 1;
const WATER_FLAG_HAS_FOAM: u32 = 1u;
const WATER_FLAG_NORMAL_MAP_2: u32 = 2u;

const PLANE_LAYER_EPSILON: f32 = 0.001;
const PRIORITY_LAYER_EPSILON: f32 = 0.001;
const FACE_PRIORITY_EPSILON: f32 = 0.001;

const tileSize: i32 = 128;
const tileSizeShift: u32 = 7u;

// ── Includes ─────────────────────────────────────────────────────────────────────────────────

// branchless-logic.glsl: GLSL mod() is floor-based, WGSL % is truncation-based.
fn glslMod(x: f32, y: f32) -> f32 {
    return x - y * floor(x / y);
}

fn glslModVec2(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> {
    return x - y * floor(x / y);
}

fn when_eq(x: f32, y: f32) -> f32 {
    return 1.0 - abs(sign(x - y));
}

fn when_neq(x: f32, y: f32) -> f32 {
    return abs(sign(x - y));
}

fn when_gt(x: f32, y: f32) -> f32 {
    return max(sign(x - y), 0.0);
}

fn when_lt(x: f32, y: f32) -> f32 {
    return max(sign(y - x), 0.0);
}

fn when_ge(x: f32, y: f32) -> f32 {
    return 1.0 - when_lt(x, y);
}

fn when_le(x: f32, y: f32) -> f32 {
    return 1.0 - when_gt(x, y);
}

fn branchlessAnd(a: f32, b: f32) -> f32 {
    return a * b;
}

fn branchlessOr(a: f32, b: f32) -> f32 {
    return min(a + b, 1.0);
}

fn branchlessXor(a: f32, b: f32) -> f32 {
    return glslMod(a + b, 2.0);
}

// hsl-to-rgb.glsl
fn hslToRgb(hsl: i32, brightness: f32) -> vec3<f32> {
    let onethird: f32 = 1.0 / 3.0;
    let twothird: f32 = 2.0 / 3.0;
    let rcpsixth: f32 = 6.0;

    let hue = f32(hsl >> 10) / 64.0 + 0.0078125;
    let sat = f32((hsl >> 7) & 0x7) / 8.0 + 0.0625;
    let lum = f32(hsl & 0x7f) / 128.0;

    var xt = vec3<f32>(
        rcpsixth * (hue - twothird),
        0.0,
        rcpsixth * (1.0 - hue),
    );

    xt = mix(xt, vec3<f32>(
        0.0,
        rcpsixth * (twothird - hue),
        rcpsixth * (hue - onethird),
    ), when_lt(hue, twothird));

    xt = mix(xt, vec3<f32>(
        rcpsixth * (onethird - hue),
        rcpsixth * hue,
        0.0,
    ), when_lt(hue, onethird));

    xt = min(xt, vec3<f32>(1.0));

    let sat2 = 2.0 * sat;
    let satinv = 1.0 - sat;
    let luminv = 1.0 - lum;
    let lum2m1 = (2.0 * lum) - 1.0;
    let ct = (sat2 * xt) + satinv;

    let rgb = mix((luminv * ct) + lum2m1, lum * ct, when_lt(lum, 0.5));

    return pow(rgb, vec3<f32>(brightness));
}

// unpack-float.glsl (GLSL had int/uint overloads; WGSL gets distinct names)
fn unpackFloat16(v: i32) -> f32 {
    let exponent = v >> 10;
    let mantissa = f32(v & 0x3FF) / 1024.0;
    return f32(exponent) + mantissa;
}

fn unpackFloat12(v: u32) -> f32 {
    return 16.0 - f32(v) / 128.0;
}

fn unpackFloat11(v: u32) -> f32 {
    return 16.0 - f32(v) / 64.0;
}

fn unpackFloat11i(v: i32) -> f32 {
    return 16.0 - f32(v) / 64.0;
}

fn unpackFloat6(v: u32) -> f32 {
    return f32(v) / 63.0;
}

fn unpackFloat6i(v: i32) -> f32 {
    return f32(v) / 63.0;
}

// material.glsl
struct Material {
    animU: i32,
    animV: i32,
    alphaCutOff: f32,
    frameCount: i32,
    animSpeed: i32,
    flags: i32,
    waterSurfaceColor: vec3<f32>,
    waterFoamColor: vec3<f32>,
    waterDepthColor: vec3<f32>,
    waterBaseOpacity: f32,
    waterFresnelAmount: f32,
    waterNormalStrength: f32,
    waterSpecularStrength: f32,
    waterSpecularGloss: f32,
    waterDuration: f32,
    waterHasFoam: f32,
    waterUseNormalMap2: bool,
};

fn getMaterial(textureId: u32) -> Material {
    let data = textureLoad(u_textureMaterials, vec2<i32>(i32(textureId), 0), 0);
    let data1 = textureLoad(u_textureMaterials, vec2<i32>(i32(textureId), 1), 0);
    let data2 = textureLoad(u_textureMaterials, vec2<i32>(i32(textureId), 2), 0);
    let data3 = textureLoad(u_textureMaterials, vec2<i32>(i32(textureId), 3), 0);
    let data4 = textureLoad(u_textureMaterials, vec2<i32>(i32(textureId), 4), 0);
    let data5 = textureLoad(u_textureMaterials, vec2<i32>(i32(textureId), 5), 0);

    var material: Material;
    material.animU = i32(data.r);
    material.animV = i32(data.g);
    material.alphaCutOff = f32(data.b & 0xFFu) / 255.0;
    material.frameCount = i32(data.a & 0xFFu);
    material.animSpeed = i32(data1.r & 0xFFu);
    material.flags = i32(data1.g & 0xFFu);
    let waterFlags = data1.b & 0xFFu;
    material.waterHasFoam = f32(waterFlags & WATER_FLAG_HAS_FOAM);
    material.waterUseNormalMap2 = (waterFlags & WATER_FLAG_NORMAL_MAP_2) != 0u;
    material.waterSurfaceColor = vec3<f32>(
        f32(data2.r & 0xFFu),
        f32(data2.g & 0xFFu),
        f32(data2.b & 0xFFu),
    ) / 255.0;
    material.waterBaseOpacity = f32(data2.a & 0xFFu) / 255.0;
    material.waterDepthColor = vec3<f32>(
        f32(data3.r & 0xFFu),
        f32(data3.g & 0xFFu),
        f32(data3.b & 0xFFu),
    ) / 255.0;
    material.waterFresnelAmount = f32(data3.a & 0xFFu) / 255.0;
    material.waterNormalStrength = f32(data4.r & 0xFFu) / 255.0 * 0.5;
    material.waterSpecularStrength = f32(data4.g & 0xFFu) / 255.0;
    material.waterSpecularGloss = max(f32(data4.b & 0xFFu) / 255.0 * 500.0, 1.0);
    material.waterDuration = f32(data4.a & 0xFFu) / 255.0 * 4.0;
    material.waterFoamColor = vec3<f32>(
        f32(data5.r & 0xFFu),
        f32(data5.g & 0xFFu),
        f32(data5.b & 0xFFu),
    ) / 255.0;
    if (material.frameCount == 0) {
        material.frameCount = 1;
    }

    return material;
}

// height-map.glsl
fn getTileHeight(x: i32, z: i32, plane: u32) -> i32 {
    return textureLoad(
        u_mapHeightMap,
        vec2<i32>(mapU.u_sceneBorderSize + x, mapU.u_sceneBorderSize + z),
        i32(plane),
        0,
    ).r * 8;
}

fn getHeightInterp(pos: vec2<f32>, plane: u32) -> f32 {
    let ipos = vec2<i32>(pos);
    let tileX = ipos.x >> tileSizeShift;
    let tileZ = ipos.y >> tileSizeShift;
    let offsetX = ipos.x & (tileSize - 1);
    let offsetZ = ipos.y & (tileSize - 1);
    let hSW = getTileHeight(tileX, tileZ, plane);
    let hSE = getTileHeight(tileX + 1, tileZ, plane);
    let hNW = getTileHeight(tileX, tileZ + 1, plane);
    let hNE = getTileHeight(tileX + 1, tileZ + 1, plane);

    // SE-NW diagonal (offsetX + offsetZ = 128)
    var h0: i32;
    if (offsetX + offsetZ <= tileSize) {
        h0 = (hSW * tileSize + (hSE - hSW) * offsetX + (hNW - hSW) * offsetZ) >> tileSizeShift;
    } else {
        let rx = tileSize - offsetX;
        let rz = tileSize - offsetZ;
        h0 = (hNE * tileSize + (hNW - hNE) * rx + (hSE - hNE) * rz) >> tileSizeShift;
    }

    // SW-NE diagonal (offsetX = offsetZ)
    var h1: i32;
    if (offsetX <= offsetZ) {
        h1 = (hSW * tileSize + (hNW - hSW) * offsetZ + (hNE - hNW) * offsetX) >> tileSizeShift;
    } else {
        h1 = (hSW * tileSize + (hSE - hSW) * offsetX + (hNE - hSE) * offsetZ) >> tileSizeShift;
    }

    return f32(max(h0, h1));
}

// fog.glsl
fn sdRoundedBox(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0))) - r;
}

fn fogFactorOSRS(playerOffset: vec2<f32>) -> f32 {
    let fogStart = min(scene.u_fogDepth, scene.u_renderDistance);
    let fogEnd = max(scene.u_renderDistance, fogStart + 0.0001);
    let rounding = min(FOG_CORNER_ROUNDING, fogEnd);
    let d = sdRoundedBox(playerOffset, vec2<f32>(fogEnd), rounding);
    return clamp(d / (fogEnd - fogStart) + 1.0, 0.0, 1.0);
}

fn fogFactorLinear(dist: f32, start: f32, end: f32) -> f32 {
    return 1.0 - clamp((dist - start) / (end - start), 0.0, 1.0);
}

// vertex.glsl
struct Vertex {
    pos: vec3<f32>,
    color: vec4<f32>,
    texCoord: vec2<f32>,
    textureId: u32,
    priority: u32,
};

fn applyHslOverride(hsl: i32, hslOverride: vec4<f32>) -> i32 {
    if (hslOverride.w <= 0.0) {
        return hsl;
    }

    var hue = (hsl >> 10) & 63;
    var sat = (hsl >> 7) & 7;
    var lum = hsl & 127;
    let iAmount = i32(hslOverride.w);

    if (hslOverride.x >= 0.0) {
        hue += (iAmount * (i32(hslOverride.x) - hue)) >> 7;
    }
    if (hslOverride.y >= 0.0) {
        sat += (iAmount * (i32(hslOverride.y) - sat)) >> 7;
    }
    if (hslOverride.z >= 0.0) {
        lum += (iAmount * (i32(hslOverride.z) - lum)) >> 7;
    }

    return (hue << 10) | (sat << 7) | lum;
}

fn decodeVertex(v0: u32, v1: u32, v2: u32, brightness: f32, actorHslOverride: vec4<f32>) -> Vertex {
    let x = f32(i32((v0 >> 17u) & 0x7FFFu) - 0x4000);
    // uPacked: low 6 bits from v0, high 5 bits from v2[4:0]
    let u = unpackFloat11(((v0 >> 11u) & 0x3Fu) | ((v2 & 0x1Fu) << 6u));
    let v = unpackFloat11(v0 & 0x7FFu);

    let y = -f32(i32(v1 & 0x7FFFu) - 0x4000);
    var hsl = i32((v1 >> 15u) & 0xFFFFu);
    let isTextured = f32((v1 >> 31u) & 0x1u);
    let textureId = f32((hsl >> 7) | i32(((v2 >> 5u) & 0x1u) << 9u)) * isTextured;

    // Actor override first, then scene override, then hslToRgb (OSRS order).
    hsl = applyHslOverride(hsl, actorHslOverride);
    hsl = applyHslOverride(hsl, scene.u_sceneHslOverride);

    let z = f32(i32((v2 >> 17u) & 0x7FFFu) - 0x4000);
    let alpha = f32((v2 >> 9u) & 0xFFu) / 255.0;
    let priority = (v2 >> 6u) & 0x7u;

    let color = vec4<f32>(when_eq(textureId, 0.0)) * vec4<f32>(hslToRgb(hsl, brightness), alpha)
        + vec4<f32>(when_neq(textureId, 0.0)) * vec4<f32>(vec3<f32>(f32(hsl & 0x7F) / 127.0), alpha);

    return Vertex(vec3<f32>(x, y, z), color, vec2<f32>(u, v), u32(textureId), priority);
}

// multi-draw.glsl: the WebGPU backend draws one range at a time and bakes the former
// u_drawIdOverride (and u_drawIdOffset) into MapUniforms.u_drawId.
fn getDrawId() -> i32 {
    return i32(mapU.u_drawId);
}

// main.vert.glsl
struct ModelInfo {
    tilePos: vec2<f32>,
    height: u32,
    plane: u32,
    planeCullLevel: u32,
    priority: u32,
    contourGround: f32,
};

fn getDataTexCoordFromIndex(index: i32) -> vec2<i32> {
    return vec2<i32>(index % 16, index / 16);
}

fn decodeModelInfo(offset: i32, instanceIndex: u32) -> ModelInfo {
    let data = textureLoad(
        u_modelInfoTexture,
        getDataTexCoordFromIndex(offset + i32(instanceIndex)),
        0,
    );

    var info: ModelInfo;
    info.tilePos = vec2<f32>(f32(data.r & 0x3FFFu), f32(data.g & 0x3FFFu));
    info.height = (data.b >> 8u) * 8u;
    info.plane = data.r >> 14u;
    info.planeCullLevel = (data.b >> 6u) & 0x3u;
    info.priority = data.b & 0x7u;
    info.contourGround = f32((data.g >> 14u) & 0x3u);

    return info;
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_color: vec4<f32>,
    @location(1) v_texCoord: vec2<f32>,
    @location(2) v_worldUv: vec2<f32>,
    @location(3) v_worldPos: vec3<f32>,
    @location(4) @interpolate(flat) v_texId: u32,
    @location(5) @interpolate(flat) v_alphaCutOff: f32,
    @location(6) v_fogAmount: f32,
    @location(7) @interpolate(flat) v_plane: f32,${ext?.world.varyings ?? ""}
};

@vertex
fn vs_main(
    @location(0) a_vertex: vec3<u32>,
    @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
    let offset = i32(textureLoad(u_modelInfoTexture, getDataTexCoordFromIndex(getDrawId()), 0).r);

    let vertex = decodeVertex(
        a_vertex.x,
        a_vertex.y,
        a_vertex.z,
        scene.u_brightness,
        vec4<f32>(-1.0, -1.0, -1.0, 0.0),
    );

    var out: VertexOutput;

    out.v_color = vertex.color;

    let material = getMaterial(vertex.textureId);
    let textureAnimation = vec2<f32>(f32(material.animU), f32(material.animV));

    if (scene.u_isNewTextureAnim > 0.5) {
        out.v_texCoord = vertex.texCoord
            + glslModVec2(glslMod(scene.u_currentTime, 128.0) * textureAnimation / 64.0, vec2<f32>(1.0));
    } else {
        out.v_texCoord = vertex.texCoord
            + (scene.u_currentTime / 0.02) * textureAnimation * TEXTURE_ANIM_UNIT;
    }
    out.v_texId = vertex.textureId;
    out.v_alphaCutOff = material.alphaCutOff;

    let modelInfo = decodeModelInfo(offset, instance_index);

    // Roof culling: use planeCullLevel for culling decision, not plane
    // planeCullLevel accounts for force-level-0 flags and bridge adjustments
    if (f32(modelInfo.planeCullLevel) > mapU.u_roofPlaneLimit + 0.5) {
        out.v_color = vec4<f32>(0.0);
        out.v_texCoord = vec2<f32>(0.0);
        out.v_worldUv = vec2<f32>(0.0);
        out.v_worldPos = vec3<f32>(0.0);
        out.v_texId = 0u;
        out.v_alphaCutOff = 1.0;
        out.v_fogAmount = 1.0;
        out.v_plane = f32(modelInfo.plane);
        // Guaranteed offscreen (w = 0 clips the triangle), replacing gl_Position = vec4(0.0).
        out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return out;
    }

    var localPos = vertex.pos + vec3<f32>(modelInfo.tilePos.x, 0.0, modelInfo.tilePos.y);

    let interpPos = modelInfo.tilePos * vec2<f32>(when_eq(modelInfo.contourGround, CONTOUR_GROUND_CENTER_TILE))
        + localPos.xz * vec2<f32>(when_eq(modelInfo.contourGround, CONTOUR_GROUND_VERTEX));
    localPos.y -= f32(modelInfo.height);
    if (modelInfo.contourGround < CONTOUR_GROUND_NONE) {
        localPos.y -= getHeightInterp(interpPos, modelInfo.plane);
    }

    localPos /= 128.0;

    localPos += vec3<f32>(mapU.u_mapPos.x, 0.0, mapU.u_mapPos.y) * 64.0;
    out.v_worldUv = localPos.xz;
    out.v_worldPos = localPos;

    let loadAlpha = smoothstep(0.0, 1.0, min(scene.u_currentTime - mapU.u_timeLoaded, 1.0));
    let isLoading = when_neq(loadAlpha, 1.0);

    // OSRS-style fog: rounded-square boundary around the player
    let playerOffset = vec2<f32>(localPos.x - scene.u_playerPos.x, localPos.z - scene.u_playerPos.y);

    // Boat decks are drawn from their own deck coordinates, so their distance to the player
    // can't be measured here; decks are always around the player, so leave them unfogged.
    let isWorldEntityDraw = mapU.u_isWorldEntity != 0u;
    var fogAmount = select(fogFactorOSRS(playerOffset), 0.0, isWorldEntityDraw);
    fogAmount = isLoading * max(1.0 - loadAlpha, fogAmount)
        + (1.0 - isLoading) * fogAmount;
    out.v_fogAmount = fogAmount;

    // World entity bobbing: applied in view/camera space, matching OSRS where
    // Scene_cameraPitchSine is multiplied after the camera transform in drawInternal.
    var viewPos = mapU.u_worldEntityTransform * (scene.u_viewMatrix * vec4<f32>(localPos, 1.0));

    // If camera looks along -Z, closer = more negative Z.
    viewPos.z += f32(modelInfo.plane) * PLANE_LAYER_EPSILON;

    // Priority 0..7: larger = closer (e.g., carpets/decals above floors)
    let mp = modelInfo.priority & 0x7u;
    if (mp > 0u) {
        viewPos.z += f32(mp) * PRIORITY_LAYER_EPSILON;
    }
    // Fine per-face bias carried in the vertex (used by locs, including carpet details)
    let fp = vertex.priority & 0x7u;
    if (fp > 0u) {
        viewPos.z += f32(fp) * FACE_PRIORITY_EPSILON;
    }

    // gl-matrix clip coords are GL-style (z in [-w, w]); WebGPU wants [0, w].
    let clip = scene.u_projectionMatrix * viewPos;
    out.position = vec4<f32>(clip.x, clip.y, (clip.z + clip.w) * 0.5, clip.w);
    out.v_plane = f32(modelInfo.plane);
${ext?.world.vertex ?? ""}
    return out;
}
` + (depth ? DEPTH_VERTEX_WGSL : "");
}
