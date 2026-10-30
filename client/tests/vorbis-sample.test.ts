import assert from "node:assert/strict";
import { BuildSteps } from "../common/utils/BuildSteps";
import { VorbisSample } from "../rs/audio/vorbis/VorbisSample";

function sample() {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    [22050, 8, 1, ~7, 4].forEach((value, i) => view.setInt32(i * 4, value));
    const decoder = new VorbisSample(bytes);
    const packets = [null, [-2, -1, -0.5], [0, 0.5, 1], [2, 0.25, 0.75]];
    const calls: number[] = [];
    (decoder as any).decodePacket = (index: number) => {
        calls.push(index);
        return packets[index] && new Float32Array(packets[index]!);
    };
    return { decoder, calls };
}

const expected = {
    sampleRate: 22050, start: 1, end: 7, looped: true,
    samples: new Int8Array([-128, -128, -64, 0, 64, 127, 127, 32]),
};

assert.deepEqual(sample().decoder.toRawSound(), expected, "retain PCM clipping, truncation and loop metadata");
const stepped = sample(), steps = stepped.decoder.toRawSoundSteps();
assert.deepEqual(stepped.calls, [], "creating steps must not decode eagerly");
for (let i = 0; i < 4; i++) {
    assert.equal(steps.next().done, false);
    assert.deepEqual(stepped.calls, Array.from({ length: i + 1 }, (_, n) => n), "each step decodes one packet");
}
assert.deepEqual(steps.next().value, expected);

const firstSteps = sample().decoder.toRawSoundSteps();
const secondSteps = sample().decoder.toRawSoundSteps();
for (let i = 0; i < 4; i++) {
    firstSteps.next();
    secondSteps.next();
}
assert.deepEqual(firstSteps.next().value, expected);
assert.deepEqual(secondSteps.next().value, expected, "alternating packets must retain separate PCM state");

void (async () => {
    const first = sample(), second = sample();
    const results = await Promise.all([
        new BuildSteps().run(first.decoder.toRawSoundSteps()),
        new BuildSteps().run(second.decoder.toRawSoundSteps()),
    ]);
    assert.deepEqual(results, [expected, expected], "the asynchronous runner preserves the decoded bytes");
    console.log("vorbis-sample ok");
})().catch(error => { console.error(error); process.exitCode = 1; });
