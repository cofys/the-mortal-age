import assert from "node:assert/strict";

import { decodeServerPacket } from "../network/packet/ServerBinaryDecoder";
import {
    encodeCameraReset,
    encodeCameraShake,
    encodeCameraMoveTo,
    encodeCameraLookAt,
    encodeCameraUnlock,
    encodeCameraTranslate,
} from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

// The server's camera shake and reset reach the client's CAMERA_CONTROL decoder intact.
const shake = decodeServerPacket(new Uint8Array(encodeCameraShake(1, 7, 0, 0))) as any;
assert.deepEqual(shake, {
    type: "camera",
    payload: { mode: "shake", slot: 1, randomAmplitude: 7, sineAmplitude: 0, sineFrequency: 0 },
});

const reset = decodeServerPacket(new Uint8Array(encodeCameraReset())) as any;
assert.deepEqual(reset, { type: "camera", payload: { mode: "reset" } });

for (const [encode, mode] of [[encodeCameraMoveTo, "move"], [encodeCameraLookAt, "look"]] as const) {
    for (const instant of [true, false]) {
        assert.deepEqual(decodeServerPacket(new Uint8Array(encode(2850, 10230, 1200, instant))), {
            type: "camera", payload: { mode, x: 2850, y: 10230, height: 1200, instant },
        });
    }
    for (const options of [{ rate: 10, rate2: 15, heightRelative: false }, { rate: 6, rate2: 0, heightRelative: true }, { rate: 232, rate2: 232, heightRelative: false }]) {
        assert.deepEqual(decodeServerPacket(new Uint8Array(encode(2850, 10230, -200, options))), {
            type: "camera", payload: { mode, x: 2850, y: 10230, height: -200, ...options },
        });
    }
    for (const easing of ["linear", "ease_in_out_sine", "ease_out_cubic"] as const) {
        const options = { cycles: 210, easing, heightRelative: false, ignoreTerrain: true, trackTarget: false };
        assert.deepEqual(decodeServerPacket(new Uint8Array(encode(3128, 3476, 400, options))), {
            type: "camera", payload: { mode, x: 3128, y: 3476, height: 400, ...options },
        });
    }
    assert.throws(() => encode(3128, 3476, 400, { cycles: 0, easing: "linear" }), RangeError);
    assert.throws(() => encode(3128, 3476, 400, { cycles: 10, easing: "unknown" } as any), RangeError);
    assert.throws(() => encode(2850, 10230, 100, { rate: -1, rate2: 10 }), RangeError);
    assert.throws(() => encode(2850, 10230, 100, { rate: 10, rate2: 256 }), RangeError);
    assert.throws(() => encode(2850, 10230, NaN, { rate: 10, rate2: 10 }), RangeError);
}

for (const unlock of [true, false]) {
    assert.deepEqual(decodeServerPacket(new Uint8Array(encodeCameraUnlock(unlock))), { type: "camera", payload: { mode: "unlock", unlock } });
}
assert.deepEqual(decodeServerPacket(new Uint8Array(encodeCameraTranslate(-5376, 8000))), {
    type: "camera", payload: { mode: "translate", dx: -5376, dy: 8000 },
});

console.log("camera shake packet: ok");
