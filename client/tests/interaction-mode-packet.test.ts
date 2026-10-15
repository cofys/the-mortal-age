import assert from "node:assert/strict";

import { decodeServerPacket } from "../network/packet/ServerBinaryDecoder";
import {
    encodeResetInteractionMode,
    encodeSetInteractionMode,
} from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

// set_interaction_mode / reset_interaction_mode reach the client with their signed world ids.
assert.deepEqual(decodeServerPacket(new Uint8Array(encodeSetInteractionMode(-2, 2, 1))), {
    type: "set_interaction_mode",
    payload: { worldId: -2, tileMode: 2, entityMode: 1 },
});
assert.deepEqual(decodeServerPacket(new Uint8Array(encodeSetInteractionMode(2773, 1, 1))), {
    type: "set_interaction_mode",
    payload: { worldId: 2773, tileMode: 1, entityMode: 1 },
});
assert.deepEqual(decodeServerPacket(new Uint8Array(encodeResetInteractionMode(-1))), {
    type: "reset_interaction_mode",
    payload: { worldId: -1 },
});

console.log("interaction mode packet: ok");
