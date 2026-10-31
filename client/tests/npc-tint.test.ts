import assert from "node:assert/strict";

import { NpcUpdateDecoder } from "../game/sync/NpcUpdateDecoder";
import {
    createNpcSyncState,
    encodeNpcSync,
} from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

/** NPC tint (OSRS npc tinting), as players have it: an HSL tint over client cycles. */
function decodeNpcs(packet: Buffer, decoder: NpcUpdateDecoder, clientCycle: number) {
    const body = packet.subarray(3);
    const length = body.readUInt16BE(9);
    return decoder.decode(body.subarray(11, 11 + length), {
        large: body[4] === 1,
        loopCycle: 0,
        clientCycle,
        localTileX: 3200,
        localTileY: 3200,
        level: 0,
    });
}

const state = createNpcSyncState();
const decoder = new NpcUpdateDecoder();
const local = { x: 3200, y: 3200, level: 0 };
const view = (tint?: object) => ({
    index: 9, typeId: 3010, x: 3204, y: 3204, level: 0,
    rotation: 0, walkDirection: -1, runDirection: -1, tint,
    forcedChat: "before", graphics: [{ id: 86, height: 0, delay: 0 }],
});

let decoded = decodeNpcs(encodeNpcSync(1, local, [view() as any], state), decoder, 100);
assert.equal(decoded.updateBlocks.get(9)?.colorOverride, undefined, "no tint without one");

decoded = decodeNpcs(
    encodeNpcSync(2, local, [view({ startCycle: 0, endCycle: 50, hue: 21, saturation: 5, lightness: -1, weight: 90 }) as any], state),
    decoder,
    200,
);
const block = decoded.updateBlocks.get(9);
assert.deepEqual(block?.colorOverride, { startCycle: 200, endCycle: 250, hue: 21, sat: 5, lum: -1, amount: 90 });
assert.equal(block?.say, "before", "the say text before it stays aligned");
assert.equal(block?.spotAnims?.[0]?.id, 86, "the spot anim after it stays aligned");
console.log("NPC tint tests passed");
