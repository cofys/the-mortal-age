import { strict as assert } from "node:assert";

import { chatHistory } from "../rs/cs2/ChatHistory";
import { Opcodes } from "../rs/cs2/Opcodes";
import { registerChatOps } from "../rs/cs2/handlers/ChatOps";
import { registerClientOps } from "../rs/cs2/handlers/ClientOps";
import type { HandlerMap } from "../rs/cs2/handlers/HandlerTypes";

// The chatbox builder (cache script 89) reads the 7th value of chat_gethistoryex_bytypeandline
// and the affix-timestamp proc (4742) prefixes it to the line when chat_gettimestamps != 0.
// Setting 119 "Chat timestamps": 0 Off, 1 On (Server time, UTC), 2 On (Local time).
const handlers: HandlerMap = new Map();
registerChatOps(handlers);
registerClientOps(handlers);

function context(mode: number, ints: number[]) {
    const pushedInts: number[] = [];
    const pushedStrings: string[] = [];
    return {
        ctx: {
            intStack: Int32Array.from(ints),
            intStackSize: ints.length,
            stringStack: [] as string[],
            stringStackSize: 0,
            chatTimestampMode: mode,
            pushInt: (v: number) => pushedInts.push(v),
            pushString: (s: string) => pushedStrings.push(s),
        } as any,
        pushedInts,
        pushedStrings,
    };
}

chatHistory.clear();
const uid = chatHistory.addMessage(0, "Welcome to Old School RuneScape.");
const message = chatHistory.getByUid(uid)!;
const at = Date.UTC(2026, 9, 25, 13, 5, 9);
message.timestamp = at;
const local = new Date(at);
const two = (n: number) => String(n).padStart(2, "0");
const localText = `[${two(local.getHours())}:${two(local.getMinutes())}:${two(local.getSeconds())}]`;

for (const [opcode, args, label] of [
    [Opcodes.CHAT_GETHISTORYEX_BYTYPEANDLINE, [0, 0], "gethistoryex_bytypeandline"],
    [Opcodes.CHAT_GETHISTORY_BYTYPEANDLINE, [0, 0], "gethistory_bytypeandline"],
    [Opcodes.CHAT_GETHISTORYEX_BYUID, [uid], "gethistoryex_byuid"],
    [Opcodes.CHAT_GETHISTORY_BYUID, [uid], "gethistory_byuid"],
] as const) {
    const handler = handlers.get(opcode)!;
    assert.ok(handler, label);
    for (const [mode, expected] of [
        [0, ""],
        [1, "[13:05:09]"],
        [2, localText],
    ] as const) {
        const { ctx, pushedInts, pushedStrings } = context(mode, [...args]);
        handler(ctx, 0, null);
        assert.equal(pushedStrings.length, 4, `${label}: four strings`);
        assert.equal(pushedInts.length, 4, `${label}: four ints`);
        assert.equal(pushedStrings[2], "Welcome to Old School RuneScape.", `${label}: text is the 3rd string`);
        assert.equal(pushedStrings[3], expected, `${label} mode ${mode}: timestamp string`);
        assert.equal(pushedInts[3], Math.floor(at / 1000), `${label} mode ${mode}: timestamp seconds`);
    }
}

// Script 4619 (settings_chat_timestamps) applies a change with gameoption_set(10, varbit 12384).
const setOption = handlers.get(Opcodes.GAMEOPTION_SET)!;
const getOption = handlers.get(Opcodes.GAMEOPTION_GET)!;
const stored: Array<[number, number]> = [];
const { ctx: optionCtx, pushedInts: optionInts } = context(0, [10, 2]);
optionCtx.setGameOption = (id: number, value: number) => stored.push([id, value]);
setOption(optionCtx, 0, null);
assert.equal(optionCtx.chatTimestampMode, 2, "game option 10 is the chat timestamp mode");
assert.deepEqual(stored, [[10, 2]], "the option store still sees it");
optionCtx.intStack = Int32Array.from([10]);
optionCtx.intStackSize = 1;
optionCtx.getGameOption = () => 0;
getOption(optionCtx, 0, null);
assert.deepEqual(optionInts, [2], "gameoption_get(10) reads the mode back");

chatHistory.clear();
console.log("chat-timestamps.test.ts: all tests passed");
