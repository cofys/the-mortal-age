import { strict as assert } from "node:assert";

import { RealtimeMidiSynth } from "../game/audio/music/realtime/RealtimeMidiSynth";

// OSRS gives each note its stereo volumes as RawPcmStream does: volume * sqrt((16384 - pan) / 8192)
// on the left and volume * sqrt(pan / 8192) on the right. A centred note plays at full volume in
// both ears (the music used to give each ear half, 6 dB under the game), and a note panned hard
// to one side plays at sqrt(2) of it there.

function processor(): any {
    let Processor: any;
    const code = (RealtimeMidiSynth.prototype as any).getWorkletProcessorCode.call({});
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", code)(
        class {
            port = { onmessage: null, postMessage() {} };
        },
        (_name: string, cls: any) => (Processor = cls),
        48000,
    );
    const instance = new Processor();
    instance.handleMessage({
        type: "loadSample",
        index: 1,
        samples: new Float32Array(64).fill(0.5),
        sampleRate: 22050,
        looped: true,
        loopStart: 0,
        loopEnd: 64,
    });
    return instance;
}

function noteOn(p: any, key: number, pan: number): any {
    p.handleMessage({
        type: "noteOn", channel: 0, key, velocity: 127, sampleIndex: 1, basePitch: key << 8,
        patchVolume: 128, pan, exclusiveClass: -1, looped: true, loopStart: 0, loopEnd: 64,
        sampleRate: 22050, volumeEnvelope: null, releaseEnvelope: null, decayRate: 0,
        volumeEnvRate: 0, releaseEnvRate: 0, decayModifier: 0, vibratoDepth: 0, vibratoRate: 0,
        vibratoDelay: 0,
    });
    const note = p.noteMap.get("0:" + key);
    p.refreshNoteAudioCache(note);
    return note;
}

function play(p: any): [number, number] {
    (globalThis as any).currentTime = 0;
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    p.process([], [[left, right]], {});
    return [left[64], right[64]];
}

{
    const p = processor();
    const note = noteOn(p, 60, 64);
    assert.equal(note.cachedPan, 8192);
    assert.ok(note.cachedVolume > 0);
    assert.equal(note.cachedLeft, note.cachedVolume, "a centred note is at full volume on the left");
    assert.equal(note.cachedRight, note.cachedVolume, "and on the right");
    const [l, r] = play(p);
    assert.equal(l, r);
    assert.equal(l, ((16384 * note.cachedVolume) >> 14) / 32768, "the mix is sample * volume >> 14");
}

{
    const p = processor();
    const note = noteOn(p, 60, 0);
    assert.equal(note.cachedPan, 0);
    assert.equal(note.cachedLeft, Math.round(note.cachedVolume * Math.SQRT2));
    assert.equal(note.cachedRight, 0);
    const [l, r] = play(p);
    assert.ok(l > 0);
    assert.equal(r, 0);
}

console.log("music-stereo-pan: ok");
