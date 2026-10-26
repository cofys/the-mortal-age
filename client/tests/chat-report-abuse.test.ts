import { strict as assert } from "node:assert";

import { decodeClientPacket } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";
import { state } from "../network/serverConnection/state";
import { Opcodes } from "../rs/cs2/Opcodes";
import { registerChatOps } from "../rs/cs2/handlers/ChatOps";
import type { HandlerMap } from "../rs/cs2/handlers/HandlerTypes";

// The report form (interface 875, script 5105) calls chat_sendabusereport(name, rule, mute).
// The Java op sends SEND_SNAPSHOT { string name, u8 rule - 1, u8 mute } (RSProx SendSnapshot:
// "the rule ids are 1 less than what is shown in clientscripts").
let sentPacket: Uint8Array | undefined;
(globalThis as any).WebSocket = { OPEN: 1 };
state.socket = { readyState: 1, send: (packet: Uint8Array) => { sentPacket = packet; } } as any;

const handlers: HandlerMap = new Map();
registerChatOps(handlers);
const report = handlers.get(Opcodes.CHAT_SENDABUSEREPORT)!;
assert.ok(report);

const send = (name: string, rule: number, mute: number) => {
    sentPacket = undefined;
    const ctx = {
        stringStack: [name],
        stringStackSize: 1,
        intStack: Int32Array.from([rule, mute]),
        intStackSize: 2,
    } as any;
    report(ctx, 0, null);
    assert.equal(ctx.intStackSize, 0, "both ints popped");
    assert.equal(ctx.stringStackSize, 0, "the name popped");
    return sentPacket ? decodeClientPacket(Buffer.from(sentPacket)) : undefined;
};

assert.deepEqual(send("Bob", 7, 0), { type: "report_abuse", name: "Bob", ruleId: 6, mute: false }, "Macroing: script value 7, wire 6");
assert.deepEqual(send("Mod Ash", 16, 1), { type: "report_abuse", name: "Mod Ash", ruleId: 15, mute: true });
assert.equal(send("", 7, 0), undefined, "no name, no packet");
assert.equal(send("   ", 7, 0), undefined);

state.socket = null;
console.log("chat-report-abuse.test.ts: all tests passed");
