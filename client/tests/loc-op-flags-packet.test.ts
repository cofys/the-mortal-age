import assert from "node:assert/strict";

import { decodeServerPacket } from "../network/packet/ServerBinaryDecoder";
import { encodeLocAddChange } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

// A loc sent with op flags (a boat's sail cloth showing only "Un-set") keeps them; one without has none.
const flagged = decodeServerPacket(new Uint8Array(encodeLocAddChange(29517, 9604, 9605, 1, 10, 0, 0b10000))) as any;
assert.deepEqual(flagged, {
    type: "loc_add_change",
    payload: { locId: 29517, tile: { x: 9604, y: 9605 }, level: 1, shape: 10, rotation: 0, opFlags: 0b10000 },
});

const plain = decodeServerPacket(new Uint8Array(encodeLocAddChange(29517, 9604, 9605, 1, 10, 3))) as any;
assert.deepEqual(plain, {
    type: "loc_add_change",
    payload: { locId: 29517, tile: { x: 9604, y: 9605 }, level: 1, shape: 10, rotation: 3 },
});

console.log("loc op flags packet: ok");
