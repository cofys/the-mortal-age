import { strict as assert } from "node:assert";

import { RealtimeMidiSynth } from "../game/audio/music/realtime/RealtimeMidiSynth";

// Channel 9 ignores Note-Off so one-shot drum samples ring out, but tracks also put melodic
// instruments there: Getting Down to Business (track 617) plays flute (patch 73, every key looped)
// on channel 9, and its notes used to sound until the track looped.

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
        samples: new Float32Array(64),
        sampleRate: 22050,
        looped: true,
        loopStart: 0,
        loopEnd: 64,
    });
    return instance;
}

function noteOn(p: any, channel: number, key: number, looped: boolean): any {
    p.handleMessage({
        type: "noteOn",
        channel,
        key,
        velocity: 100,
        sampleIndex: 1,
        basePitch: key << 8,
        patchVolume: 100,
        pan: 64,
        exclusiveClass: -1,
        looped,
        loopStart: 0,
        loopEnd: 0,
        sampleRate: 22050,
        volumeEnvelope: null,
        releaseEnvelope: null,
        decayRate: 0,
        volumeEnvRate: 0,
        releaseEnvRate: 0,
        decayModifier: 0,
        vibratoDepth: 0,
        vibratoRate: 0,
        vibratoDelay: 0,
    });
    return p.noteMap.get(channel + ":" + key);
}

{
    const p = processor();
    const flute = noteOn(p, 9, 72, true);
    p.handleMessage({ type: "noteOff", channel: 9, key: 72 });
    assert.ok(flute.releaseProgress >= 0, "a looped note on channel 9 is released");
}

{
    const p = processor();
    const drum = noteOn(p, 9, 38, false);
    p.handleMessage({ type: "noteOff", channel: 9, key: 38 });
    assert.equal(drum.releaseProgress, -1, "a one-shot drum hit still rings out");
}

{
    const p = processor();
    const note = noteOn(p, 3, 60, true);
    p.handleMessage({ type: "noteOff", channel: 3, key: 60 });
    assert.ok(note.releaseProgress >= 0, "other channels are unchanged");
}

console.log("music-channel9-noteoff: ok");
