import assert from "node:assert/strict";

import { decodeServerPacket } from "../network/packet/ServerBinaryDecoder";
import { encodeWidgetSetItem } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

const uid = (807 << 16) | 8;
for (const itemId of [0, 4151, 32767, 32768, 32926, 65534, -1]) {
    const message = decodeServerPacket(new Uint8Array(encodeWidgetSetItem(uid, itemId, 37)));
    assert.deepEqual(message, {
        type: "widget",
        payload: { action: "set_item", uid, itemId, quantity: 37 },
    }, `item ${itemId}: only wire 65535 clears the widget model`);
}

console.log("widget set item packet: unsigned item IDs and clear sentinel pass");
