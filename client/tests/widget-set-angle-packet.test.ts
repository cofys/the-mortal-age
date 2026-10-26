import assert from "node:assert/strict";

import { decodeServerPacket } from "../network/packet/ServerBinaryDecoder";
import { encodeWidgetSetAngle } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

// IF_SETANGLE reaches the client as the game sends it: the component, its model's x and y angles
// and zoom. The values are the balloon controls' (rsprox 226/01702): a bird on zep_grid_10_2
// (470:219) at 201, 318 and 2576; the storm creature at 99, 333 and 3472; a cleared cell at 0, 0.
const uid = (470 << 16) | 219;
const decode = (x: number, y: number, zoom: number) =>
    decodeServerPacket(new Uint8Array(encodeWidgetSetAngle(uid, x, y, zoom))) as any;

assert.deepEqual(decode(201, 318, 2576), {
    type: "widget",
    payload: { action: "set_angle", uid, angleX: 201, angleY: 318, zoom: 2576 },
});
assert.deepEqual(decode(99, 333, 3472).payload, { action: "set_angle", uid, angleX: 99, angleY: 333, zoom: 3472 });
assert.deepEqual(decode(0, 0, 2576).payload, { action: "set_angle", uid, angleX: 0, angleY: 0, zoom: 2576 });
assert.equal(decode(2047, 2047, 65535).payload.zoom, 65535, "zoom is unsigned");

console.log("widget set angle packet: ok");
