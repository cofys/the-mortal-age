import assert from "node:assert/strict";

import { packTemplateChunk, rotateChunkX, rotateChunkY } from "../common/instance/InstanceTypes";
import { LocLoadType, SceneBuilder } from "../rs/scene/SceneBuilder";
import { generateHeight } from "../rs/util/HeightCalc";

function terrain(newFormat: boolean, heightOffset = 0): Int8Array {
    const bytes: number[] = [];
    const word = (value: number) => {
        if (newFormat) bytes.push((value >>> 8) & 255);
        bytes.push(value & 255);
    };
    for (let plane = 0; plane < 4; plane++) for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) {
        word(2 + 3 * 4 + ((x + y) & 3));
        word(-7);
        word(82 + x % 6);
        const flags = (plane + x + y) & 3;
        if (flags) word(49 + flags);
        const height = (plane + x + 2 * y + heightOffset) % 24;
        word(height === 0 ? 0 : 1);
        if (height !== 0) bytes.push(height);
    }
    return Int8Array.from(bytes);
}

for (const revision of [208, 237]) {
    let data = terrain(revision >= 209);
    const builder: any = new SceneBuilder({ game: "oldschool", revision } as any,
        {} as any, {} as any, {} as any, {} as any, {} as any, new Map());
    builder.loadInstanceRegionArchives = () => new Map([[(50 << 8) | 50, { terrain: data }]]);
    builder.addTileModels = () => {};
    const templates = Array.from({ length: 4 }, () =>
        Array.from({ length: 13 }, () => Array(13).fill(-1)));
    for (let cx = 0; cx < 13; cx++) for (let cy = 0; cy < 13; cy++) {
        templates[0][cx][cy] = packTemplateChunk((cx + cy) & 3, 400 + cx % 8, 400 + cy % 8, (cx + cy) & 3);
    }
    templates[1][1][1] = packTemplateChunk(2, 403, 404, 3);
    let skipped = 0, applied = 0;
    const decode = builder.decodeTerrainTile;
    builder.decodeTerrainTile = function (...args: any[]) {
        if (args[2] < 0) skipped++; else applied++;
        return decode.apply(this, args);
    };
    const build = () => builder.buildInstanceScene(templates, 0, 0, 104, 104, false, LocLoadType.NO_MODELS);
    const scene = build();
    assert.equal(skipped, 4 * 64 * 64, "scan the source archive once per build, rather than once per chunk");
    assert.equal(applied, 170 * 64, "decode exactly the selected 8x8 tiles for each template");
    for (let cx = 0; cx < 13; cx++) for (let cy = 0; cy < 13; cy++) {
        const plane = (cx + cy) & 3;
        const rotation = (cx + cy) & 3;
        for (let lx = 0; lx < 8; lx++) for (let ly = 0; ly < 8; ly++) {
            const sx = cx % 8 * 8 + lx, sy = cy % 8 * 8 + ly;
            const dx = cx * 8 + rotateChunkX(lx, ly, rotation);
            const dy = cy * 8 + rotateChunkY(lx, ly, rotation);
            const height = (plane + sx + 2 * sy) % 24;
            const expected = height === 0
                ? -generateHeight(3200 + sx + 932731, 3200 + sy + 556238) * 8
                : -(height === 1 ? 0 : height) * 8;
            assert.equal(scene.tileHeights[0][dx][dy], expected | 0);
            assert.equal(scene.tileOverlays[0][dx][dy], -7);
            assert.equal(scene.tileUnderlays[0][dx][dy], 1 + sx % 6);
            assert.equal(scene.tileShapes[0][dx][dy], 3);
            assert.equal(scene.tileRotations[0][dx][dy], ((sx + sy) + rotation) & 3);
            assert.equal(scene.tileRenderFlags[0][dx][dy], (plane + sx + sy) & 3);
        }
    }
    for (let lx = 0; lx < 8; lx++) for (let ly = 0; ly < 8; ly++) {
        const dx = 8 + rotateChunkX(lx, ly, 3), dy = 8 + rotateChunkY(lx, ly, 3);
        const height = (2 + 24 + lx + 2 * (32 + ly)) % 24;
        const delta = height === 0 ? 240 : (height === 1 ? 0 : height) * 8;
        assert.equal(scene.tileHeights[1][dx][dy], scene.tileHeights[0][dx][dy] - delta,
            "upper-floor heights remain relative to the destination floor below");
    }
    const previous = scene.tileHeights[0][2][3];
    data = terrain(revision >= 209, 5);
    skipped = applied = 0;
    const replacement = build();
    assert.equal(skipped, 4 * 64 * 64, "indexes are job-local, including replacement archives");
    assert.notEqual(replacement.tileHeights[0][2][3], previous);
    data = data.subarray(0, data.length - 1);
    assert.throws(build, /Buffer overflow/, "malformed terrain must retain its decode error");
}
console.log("Instance terrain indexing: both formats, rotations, noise and relative heights passed");
