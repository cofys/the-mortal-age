import assert from "node:assert/strict";
import { test } from "node:test";
import { LocAnimated } from "../render/loc/LocAnimated";
import { LocAnimationUpdater, type LocAnimationGeometry } from "../render/loc/LocAnimationUpdater";
import { newDrawRange } from "../render/DrawRange";

(globalThis as any).self = globalThis;
const { WebGLMapSquare } = require("../render/WebGLMapSquare");

function sequence(skeletal: boolean) {
    return { id: 1, frameIds: [10, 11, 12], frameLengths: [6, 6, 6], frameStep: 2,
        frameSounds: new Map([[0, [1]], [1, [1]], [2, [1]]]),
        isSkeletalSeq: () => skeletal, getSkeletalDuration: () => 3,
        getFrameLength: () => 6 } as any;
}

function loc(skeletal = false, smooth = true): LocAnimated {
    const frames = Array.from({ length: smooth && !skeletal ? 12 : 3 }, (_, i) => newDrawRange(i * 24, i * 6));
    return new LocAnimated(0, 0, 0, 0, -1, -1, -1, -1,
        { frames, framesAlpha: frames.map(r => newDrawRange(r[0] + 1000, r[1] + 3)),
            frameStarts: smooth && !skeletal ? [0, 4, 8] : undefined },
        sequence(skeletal), 0, false, 44776, 10, 20, 0, 1);
}

function geometry(): LocAnimationGeometry {
    const batch = () => {
        const range = newDrawRange(0, 0);
        range.chunk = [8, 16]; range.bounds = [8, -4, 16, 16, 4, 24];
        return { drawRanges: [range], drawCall: { offsets: [0], numElements: [0] } };
    };
    return { drawCall: batch(), drawCallAlpha: batch(), drawCallLod: batch(), drawCallLodAlpha: batch() };
}

test("WebGL shares opaque/alpha/full/far poses across 240 FPS, HD and sunken passes", () => {
    const animated = loc();
    const batches = geometry();
    const square = Object.assign(Object.create(WebGLMapSquare.prototype), {
        locsAnimated: [animated], loc: batches, locAnimationUpdater: new LocAnimationUpdater(),
    });
    let updates = 0, selections = 0;
    const originalUpdate = animated.update.bind(animated), originalDrawFrame = animated.drawFrame.bind(animated);
    animated.update = (...args) => { updates++; return originalUpdate(...args); };
    animated.drawFrame = () => { selections++; return originalDrawFrame(); };
    for (let frame = 0; frame < 240; frame++) {
        const cycle = Math.floor(frame * 50 / 240);
        // Tick, opaque, alpha, HD opaque/alpha and SunkenLocs all visit this map.
        square.updateAnimatedLocs({}, cycle, () => {});
        for (let pass = 0; pass < 5; pass++) square.updateAnimatedLocs({}, cycle);
    }
    assert.equal(updates, 50);
    assert.equal(selections, 50);
    const changed = geometry();
    square.loc = changed;
    square.updateAnimatedLocs({}, 49);
    assert.equal(updates, 51, "a partial rebuild repairs ranges during the same client cycle");
    assert.equal(selections, 51);
    assert.deepEqual(changed.drawCall!.drawRanges[0].slice(), batches.drawCall!.drawRanges[0].slice());
});

test("submitted poses and sounds match unthrottled legacy/skeletal/smoothed animation timing", () => {
    for (const skeletal of [false, true]) for (const smooth of [false, true]) {
        const expected = loc(skeletal, smooth), actual = loc(skeletal, smooth);
        const updater = new LocAnimationUpdater(), batches = geometry();
        const locs = [actual];
        const expectedSounds: number[] = [], actualSounds: number[] = [];
        const sound = (_: unknown, frame: number) => actualSounds.push(frame);
        const expectedSound = (_: unknown, frame: number) => expectedSounds.push(frame);
        for (let frame = 0; frame < 240; frame++) {
            const cycle = Math.floor(frame * 50 / 240);
            expected.update({} as any, cycle, expectedSound);
            const key = expected.drawFrame();
            updater.update(locs, batches, {} as any, cycle, sound);
            updater.update(locs, batches, {} as any, cycle);
            for (const alpha of [false, true]) for (const lod of [false, true]) {
                const batch = alpha ? (lod ? batches.drawCallLodAlpha : batches.drawCallAlpha)
                    : (lod ? batches.drawCallLod : batches.drawCall);
                const range = (alpha ? expected.anim.framesAlpha! : expected.anim.frames)[key];
                assert.deepEqual(batch!.drawRanges[0].slice(), range.slice(), `pose at ${cycle}, skeletal=${skeletal}, smooth=${smooth}`);
                assert.deepEqual(batch!.drawRanges[0].chunk, [8, 16]);
                assert.deepEqual(batch!.drawRanges[0].bounds, [8, -4, 16, 16, 4, 24]);
                assert.equal(batch!.drawCall!.offsets[0], range[0]);
                assert.equal((batch!.drawCall as any).numElements[0], range[1]);
            }
        }
        assert.deepEqual(actualSounds, expectedSounds);
    }
});
