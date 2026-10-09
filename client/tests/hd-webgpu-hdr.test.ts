import assert from "node:assert/strict";
import { test } from "node:test";

import { createMainFragmentWgsl } from "../render/webgpu/shaders/main.frag.wgsl";
import { HD_SCENE_SHADERS } from "../game/plugins/hd/webgpu/hdSceneShaders";

test("extended world shader writes unclamped linear HDR into the offscreen target", () => {
    const base = createMainFragmentWgsl(false);
    const extended = createMainFragmentWgsl(false, HD_SCENE_SHADERS);

    assert.match(base, /clamp\(finalRgb/, "base pipeline must keep clipping to the canvas");
    assert.ok(
        !extended.includes("clamp(finalRgb"),
        "extended pipeline writes HDR; the tonemap pass owns the display transform",
    );
    assert.match(base, /return clamp\(baseColor/, "base water highlights clip");
    assert.match(
        extended,
        /return max\(baseColor/,
        "extended water keeps specular headroom above 1 for bloom",
    );
});

test("117HD shade returns linear HDR, not the old display-referred grade", () => {
    const wgsl = HD_SCENE_SHADERS.world.declarations;

    assert.match(wgsl, /HD_EMISSIVE_GAIN/, "unlit HD materials must be emissive for bloom");
    assert.ok(
        !wgsl.includes("1.0 / 2.2"),
        "hdShade must not gamma-encode into the HDR target",
    );
    assert.match(
        HD_SCENE_SHADERS.world.shade,
        /pow\(max\(surface/,
        "skipped surfaces (floor water) are linearised to match the HDR target",
    );
});

test("117HD metadata.y is read as the HdMaterials.ts bitfield", () => {
    // Bit 0 = unlit, bit 1 = worldUv (castle/red brick walls use world-aligned masonry).
    assert.match(
        HD_SCENE_SHADERS.world.declarations,
        /\(i32\(metadata\.y\) & 1\) != 0/,
        "hdShade must test the unlit bit, not metadata.y > 0.5",
    );
    assert.match(
        HD_SCENE_SHADERS.world.textureSample,
        /i32\(hdMetadata\.y\) & 2/,
        "world shaders must apply the worldUv masonry mapping to wall materials",
    );
});
