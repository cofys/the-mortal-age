import assert from "node:assert/strict";

const { CacheSystem } = require("../rs/cache/CacheSystem");
const { loadCache, loadCacheInfos, loadCacheList } = require("../scripts/cache/load-util");
const { SoundEffectLoader } = require("../rs/audio/SoundEffectLoader");
const { loadVorbisSample } = require("../game/audio/VorbisWasm");
const { IndexType } = require("../rs/cache/IndexType");
const { VorbisSample, resetSetup, initVorbisSetup, isSetupInitialized } = require("../rs/audio/vorbis/VorbisSample");

/**
 * OSRS's newer sound effects are sampled, not synths: file 1 of their archive in the sound
 * effects index holds their own Vorbis setup and a Vorbis sample (rev 241: from 11988 on; Ocellus'
 * transformations, quadrant destruction and death among them). They decode, and the music
 * samples' shared setup is left as it was.
 */
async function main(): Promise<void> {
    const cacheInfo = loadCacheList(loadCacheInfos()).latest;
    const cache = CacheSystem.fromFiles(cacheInfo, loadCache(cacheInfo).files);
    const loader = new SoundEffectLoader(cacheInfo, cache);

    const music = cache.getIndex(IndexType.DAT2.musicSamples);
    const group = (Array.from(music.getArchiveIds() as Int32Array) as number[]).find((id) => id > 0)!;
    const file = (Array.from(music.getFileIds(group) as Int32Array) as number[])[0];
    const before = await loadVorbisSample(cache, group, file);
    assert.ok(before);
    const data = music.getFile(group, file).data;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const synchronous = new VorbisSample(bytes).toRawSound();
    assert.deepEqual(synchronous, before, "cooperative loading retains the complete PCM and loop metadata");
    const first = new VorbisSample(bytes).toRawSoundSteps();
    const second = new VorbisSample(bytes).toRawSoundSteps();
    let a = first.next(), b = second.next();
    resetSetup();
    try {
        assert.ok(loader.load(12819), "a sound with its own setup can decode between music packets");
        while (!a.done || !b.done) {
            if (!a.done) a = first.next();
            if (!b.done) b = second.next();
        }
        assert.deepEqual(a.value, synchronous);
        assert.deepEqual(b.value, synchronous, "interleaved samples keep their captured setup after a cache reset");
        assert.equal(isSetupInitialized(), false, "resuming an older sample cannot restore a replaced global setup");
    } finally {
        const setup = music.getFile(0, 0).data;
        initVorbisSetup(new Uint8Array(setup.buffer, setup.byteOffset, setup.byteLength));
    }

    for (const id of [12819, 12825, 12814, 12837, 12826]) {
        const raw = loader.load(id);
        assert.ok(raw, `sound ${id} decodes`);
        assert.equal(raw!.sampleRate, 44100);
        assert.ok(raw!.samples.length > 44100, `sound ${id} lasts over a second`);
        assert.ok(raw!.samples.some((sample: number) => Math.abs(sample) > 32), `sound ${id} is not silent`);
    }
    assert.ok(loader.load(12604), "an older synth still decodes");

    const after = await loadVorbisSample(cache, group, file);
    assert.ok(before && after);
    assert.deepEqual(Array.from(after!.samples), Array.from(before!.samples), "the music's setup is untouched");
    console.log("Sampled sound effect tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
