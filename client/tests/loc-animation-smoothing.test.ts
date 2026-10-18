import { nextSequenceFrame } from "../rs/model/seq/FrameInterpolation";
import { strict as assert } from "node:assert";

import { LocAnimated } from "../render/loc/LocAnimated";
import { SdMapDataLoader } from "../render/loader/SdMapDataLoader";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../rs/config/loctype/LocModelLoader";
import { NpcModelLoader } from "../rs/config/npctype/NpcModelLoader";
import { PlayerModelLoader } from "../rs/config/player/PlayerModelLoader";
import { VarManager } from "../rs/config/vartype/VarManager";
import { SceneBuilder } from "../rs/scene/SceneBuilder";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// --- LocAnimated.drawFrame: a cycle into a keyframe picks its blended step.

// Three 6-cycle keyframes, baked smoothed as 4 + 4 + 1 frames (the last is never blended).
const seq: any = {
    id: 1,
    frameIds: [10, 11, 12],
    frameLengths: [6, 6, 6],
    frameStep: -1,
    isSkeletalSeq: () => false,
    getFrameLength: (_: unknown, frame: number) => 6,
};
const frames = Array.from({ length: 9 }, (_, i) => [i, 1, 0] as any);
const anim = { frames, framesAlpha: undefined, frameStarts: [0, 4, 8] };
const loc = new LocAnimated(0, -1, -1, -1, 0, -1, -1, -1, anim, seq, 0, false, 1, 0, 0, 0, 0);
const drawn: number[] = [];
for (let cycle = 0; cycle < 13; cycle++) {
    loc.update({} as any, cycle);
    drawn.push(loc.drawFrame());
}
// Keyframe 0 over cycles 0-5 steps 0,0,1,2,2,3; keyframe 1 the same from 4; keyframe 2 is 8.
assert.deepEqual(drawn, [0, 0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8]);
assert.equal(loc.frame, 2, "frame stays the keyframe (sounds, highlight)");

// Unsmoothed bakes draw the keyframe itself.
const plain = new LocAnimated(0, -1, -1, -1, 0, -1, -1, -1, { frames: frames.slice(0, 3), framesAlpha: undefined }, seq, 0, false, 1, 0, 0, 0, 0);
plain.update({} as any, 7);
assert.equal(plain.drawFrame(), 1);

// --- The Lumbridge flag (loc 5628, seq 1730: 8 keyframes) bakes blended steps when smoothed.

const info = loadCacheList(loadCacheInfos()).latest;
const cache = loadCache(info);
const f = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, cache.files));
const varManager = new VarManager(f.getVarBitTypeLoader());
const locModelLoader = new LocModelLoader(
    f.getLocTypeLoader(), f.getModelLoader(), f.getTextureLoader(),
    f.getSeqTypeLoader(), f.getSeqFrameLoader(), f.getSkeletalSeqLoader(),
);
const state: any = {
    cache, cacheLoaderFactory: f, varManager, npcInstances: [], locModelLoader,
    locTypeLoader: f.getLocTypeLoader(), objTypeLoader: f.getObjTypeLoader(), npcTypeLoader: f.getNpcTypeLoader(),
    idkTypeLoader: f.getIdkTypeLoader(), seqTypeLoader: f.getSeqTypeLoader(), basTypeLoader: f.getBasTypeLoader(),
    textureLoader: f.getTextureLoader(), seqFrameLoader: f.getSeqFrameLoader(), skeletalSeqLoader: f.getSkeletalSeqLoader(),
    npcModelLoader: new NpcModelLoader(f.getNpcTypeLoader(), f.getModelLoader(), f.getTextureLoader(),
        f.getSeqTypeLoader(), f.getSeqFrameLoader(), f.getSkeletalSeqLoader(), varManager),
    playerModelLoader: new PlayerModelLoader(f.getIdkTypeLoader(), f.getObjTypeLoader(), f.getModelLoader(), f.getTextureLoader()),
    sceneBuilder: new SceneBuilder(info, f.getMapFileLoader(), f.getUnderlayTypeLoader(), f.getOverlayTypeLoader(),
        f.getLocTypeLoader(), locModelLoader, cache.xteas),
    minimapImageRenderer: { renderMinimap: () => undefined, renderMinimapHd: () => undefined },
};

async function flagAnim(smooth: boolean, steps = 4) {
    const result: any = await new SdMapDataLoader().load(state, {
        mapX: 50, mapY: 50, maxLevel: 3, loadNpcs: false, smoothTerrain: true, minimizeDrawCalls: true,
        loadedTextureIds: new Set<number>(), smoothLocAnimations: smooth, smoothLocAnimationSteps: steps,
    });
    const flag = result.data.locsAnimated.find((l: any) => l.locId === 5628);
    assert.ok(flag, "flag at 3211, 3225");
    return flag.anim;
}

(async () => {
    const off = await flagAnim(false);
    assert.equal(off.frames.length, 8);
    assert.equal(off.frameStarts, undefined);

    const on = await flagAnim(true);
    const seq1730 = state.seqTypeLoader.load(1730);
    const expected = seq1730.frameIds.map((_: number, i: number) =>
        nextSequenceFrame(seq1730, i, "object") !== undefined
            ? Math.max(1, Math.min(seq1730.getFrameLength(state.seqFrameLoader, i), 4))
            : 1,
    );
    assert.equal(on.frames.length, expected.reduce((a: number, b: number) => a + b, 0));
    assert.equal(on.frameStarts.length, 8);
    assert.equal(on.frameStarts[0], 0);
    // A blended step is new geometry, not a copy of its keyframe.
    assert.notEqual(on.frames[1][0], on.frames[0][0]);

    const high = await flagAnim(true, 8);
    const maximum = await flagAnim(true, 0);
    const expectedCount = (steps: number) => seq1730.frameIds.reduce((n: number, _: number, i: number) => {
        const length = nextSequenceFrame(seq1730, i, "object") === undefined ? 1 : seq1730.getFrameLength(state.seqFrameLoader, i);
        return n + Math.max(1, Math.min(length, steps || length));
    }, 0);
    assert.equal(high.frames.length, expectedCount(8));
    assert.equal(maximum.frames.length, expectedCount(0));
    assert.ok(maximum.frames.length >= on.frames.length);
    console.log("loc animation smoothing tests passed");
    process.exit(0);
})();
