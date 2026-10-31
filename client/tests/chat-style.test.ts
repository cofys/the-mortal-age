import assert from "node:assert/strict";

import { parseOutgoingPublicChat } from "../common/chat/chatFormatting";
import { ClientBinaryEncoder } from "../network/packet/ClientBinaryEncoder";
import { decodeClientPacket } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";

/** Public chat's colour and effect ("red:wave:") reach the server with the text. */
const encoder = new ClientBinaryEncoder();
const send = (typed: string) => {
    const formatting = parseOutgoingPublicChat(typed);
    return decodeClientPacket(Buffer.from(encoder.encodeChat(formatting.text, "public", false, formatting)));
};

const plain = send("hello") as any;
assert.equal(plain.text, "hello");
assert.equal(plain.style, undefined, "no style without a prefix");

const styled = send("red:wave:hello") as any;
assert.equal(styled.text, "hello");
assert.deepEqual(styled.style, { colour: 1, effect: 1, pattern: undefined });
console.log("Chat style tests passed");
