import assert from "node:assert/strict";
import { Opcodes } from "../rs/cs2/Opcodes";
import { registerConfigOps } from "../rs/cs2/handlers/ConfigOps";

// oc_cert / oc_uncert as the real client has them: a note and its item link each other through
// `note`, the note carries `noteTemplate`, and anything else comes back as it is (Dom Onion's
// Reward Shop draws noted flax un-noted, and its potions as they are, through oc_uncert).
const objs: Record<number, { note: number; noteTemplate: number }> = {
    1779: { note: 1780, noteTemplate: -1 }, // Flax
    1780: { note: 1779, noteTemplate: 799 }, // Flax (noted)
    11725: { note: -1, noteTemplate: -1 }, // Super ranging (1), never noted
};
const ctx: any = {
    intStack: new Int32Array(8),
    intStackSize: 0,
    pushInt(value: number) { this.intStack[this.intStackSize++] = value; },
    objTypeLoader: { load: (id: number) => objs[id] ?? null },
};
const handlers = new Map<any, any>();
registerConfigOps(handlers);
const run = (opcode: Opcodes, id: number) => {
    ctx.intStack[ctx.intStackSize++] = id;
    handlers.get(opcode)(ctx, 0, null);
    return ctx.intStack[--ctx.intStackSize];
};

assert.equal(run(Opcodes.OC_UNCERT, 1780), 1779, "a note uncerts to its item");
assert.equal(run(Opcodes.OC_UNCERT, 1779), 1779, "an item is already uncerted");
assert.equal(run(Opcodes.OC_UNCERT, 11725), 11725, "an item that is never noted stays itself");
assert.equal(run(Opcodes.OC_CERT, 1779), 1780, "an item certs to its note");
assert.equal(run(Opcodes.OC_CERT, 1780), 1780, "a note is already certed");
assert.equal(run(Opcodes.OC_CERT, 11725), 11725, "an item with no note stays itself");
