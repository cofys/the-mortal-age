import assert from "node:assert/strict";
import { getMusicWorkletUnsupportedReason } from "../game/audio/audioContext";

// A client opened over plain HTTP on a tailnet hostname has Web Audio but no AudioWorklet (#1502).
const g = globalThis as any;
g.window = {
    AudioContext: function AudioContext() {},
    isSecureContext: false,
    location: { origin: "http://laptop.tail806fe2.ts.net:3000" },
};
assert.equal(
    getMusicWorkletUnsupportedReason(),
    "music needs HTTPS or localhost (page is http://laptop.tail806fe2.ts.net:3000)",
);

g.window.isSecureContext = true;
assert.equal(getMusicWorkletUnsupportedReason(), "AudioWorklet is not supported");

g.AudioWorkletNode = function AudioWorkletNode() {};
assert.equal(getMusicWorkletUnsupportedReason(), null);

g.window.AudioContext = undefined;
assert.equal(getMusicWorkletUnsupportedReason(), "Web Audio is not supported");
