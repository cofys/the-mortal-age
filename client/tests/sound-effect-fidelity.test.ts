import assert from "node:assert/strict";

const { CacheSystem } = require("../rs/cache/CacheSystem");
const { loadCache, loadCacheInfos, loadCacheList } = require("../scripts/cache/load-util");
const { SoundEffectLoader } = require("../rs/audio/SoundEffectLoader");
const { SoundEffectSystem } = require("../game/audio/SoundEffectSystem");

/**
 * Sound effects play as OSRS mixes them: every 8-bit sample as it is, at the effect's own rate
 * (22050 Hz synths, 44100 Hz sampled effects) and at OSRS's level (volume 127 of a 24-bit mix,
 * written as 16 bits: 127/256 of full scale). Nothing filters or resamples them in the client;
 * Web Audio takes the buffer at that rate. A low-pass used to dull them, and they played at
 * twice the level, clipping where they overlapped.
 */
const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const cache = CacheSystem.fromFiles(cacheInfo, loadCache(cacheInfo).files);
const loader = new SoundEffectLoader(cacheInfo, cache);
const system = new SoundEffectSystem(loader);

for (const [id, rate] of [[2393, 22050], [7700, 22050], [12819, 44100]] as const) {
    const raw = loader.load(id);
    assert.ok(raw, `sound ${id} decodes`);
    const decoded = (system as any).decode(id);
    assert.equal(decoded.sampleRate, rate, `sound ${id} keeps its own rate`);
    assert.equal(decoded.channelData.length, raw!.samples.length, `sound ${id} is not resampled`);
    for (let i = 0; i < raw!.samples.length; i++) {
        if (decoded.channelData[i] !== Math.fround((raw!.samples[i] * 127) / 32768)) {
            assert.fail(`sound ${id} sample ${i}: ${decoded.channelData[i]} is filtered (raw ${raw!.samples[i]})`);
        }
    }
    const peak = decoded.channelData.reduce((max: number, v: number) => Math.max(max, Math.abs(v)), 0);
    assert.ok(peak <= 128 * 127 / 32768 + 1e-6, `sound ${id} peaks at OSRS's level (${peak})`);
}
console.log("Sound effect fidelity tests passed");
