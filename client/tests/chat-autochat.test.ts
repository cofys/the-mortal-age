import { strict as assert } from "node:assert";

import { decodeClientPacket } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";
import { state } from "../network/serverConnection/state";
import { Opcodes } from "../rs/cs2/Opcodes";
import { registerChatOps } from "../rs/cs2/handlers/ChatOps";
import type { HandlerMap } from "../rs/cs2/handlers/HandlerTypes";

// Autochat is a cache-script timer (proc 552): every 150 client cycles it calls
// chat_sendpublic(text, 1), type 1 being "autotyper" in the MESSAGE_PUBLIC type table
// (0 normal, 1 autotyper, 2 friends channel, 3/4 clan). The server must learn the flag.
let sentPacket: Uint8Array | undefined;
(globalThis as any).WebSocket = { OPEN: 1 };
state.socket = { readyState: 1, send: (packet: Uint8Array) => { sentPacket = packet; } } as any;

const handlers: HandlerMap = new Map();
registerChatOps(handlers);
const sendPublic = handlers.get(Opcodes.CHAT_SENDPUBLIC)!;
assert.ok(sendPublic);

const send = (text: string, type: number) => {
    sentPacket = undefined;
    const cleared: Array<[number, string]> = [];
    sendPublic(
        {
            stringStack: [text],
            stringStackSize: 1,
            intStack: Int32Array.from([type]),
            intStackSize: 1,
            varManager: { setVarcString: (id: number, value: string) => cleared.push([id, value]) },
        } as any,
        0,
        null,
    );
    assert.ok(sentPacket, `${text} (type ${type}) sends a packet`);
    assert.deepEqual(cleared, [[335, ""]], "the input buffer is cleared either way");
    return decodeClientPacket(Buffer.from(sentPacket!));
};

assert.deepEqual(send("buying gf", 1), { type: "chat", text: "buying gf", messageType: "public", autoChat: true });
assert.deepEqual(send("hello", 0), { type: "chat", text: "hello", messageType: "public" }, "plain public chat carries no flag");
assert.deepEqual(send("/hi channel", 2), { type: "chat", text: "hi channel", messageType: "friends_chat" });

state.socket = null;
console.log("chat-autochat.test.ts: all tests passed");
