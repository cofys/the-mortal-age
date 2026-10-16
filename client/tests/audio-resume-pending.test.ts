import assert from "node:assert/strict";
import { resumeAudioContextIfNeeded } from "../game/audio/audioContext";

// Without user activation resume() stays pending; per-frame callers must not stack promises.
let calls = 0;
let start = () => {};
const ctx = {
    state: "suspended",
    resume() {
        calls++;
        return new Promise<void>((resolve) => {
            start = () => {
                this.state = "running";
                resolve();
            };
        });
    },
};
for (let frame = 0; frame < 100; frame++) resumeAudioContextIfNeeded(ctx as unknown as AudioContext);
assert.equal(calls, 1, "one resume() in flight per context");

void (async () => {
    start();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.state = "suspended";
    resumeAudioContextIfNeeded(ctx as unknown as AudioContext);
    assert.equal(calls, 2, "a settled resume() lets the next one through");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
