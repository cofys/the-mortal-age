import assert from "node:assert/strict";
import { test } from "node:test";

import { NpcEcs } from "../game/ecs/NpcEcs";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { updateNpcClientAnimations } from "../render/webgpu/actors/actorPacking";

test("crowded NPCs share frame timings while movement loops and actions finish independently", () => {
    const ecs = new NpcEcs();
    const seq = new SeqType(1, { game: "oldschool", revision: 241 } as any);
    seq.frameIds = [1, 2, 3];
    let timingReads = 0;
    seq.frameLengths = new Proxy([0, 2, 1], {
        get: (target, key, receiver) => {
            if (typeof key === "string" && /^\d+$/.test(key)) timingReads++;
            return Reflect.get(target, key, receiver);
        },
        set: () => { throw new Error("shared frame timings must remain unchanged"); },
    });
    const client = {
        npcEcs: ecs,
        playerEcs: {},
        npcTypeLoader: { load: () => ({ getMovementSeqSet: () => ({ idle: 1, walk: 1 }) }) },
        seqTypeLoader: { load: () => seq },
    } as any;
    const ids = Array.from({ length: 64 }, (_, i) => {
        const id = ecs.createNpc(50, 50, 1, 1, 64, 64, 0, 0, 0, 0);
        ecs.setServerMapping(id, i + 1);
        ecs.setSequenceId(id, 1);
        return id;
    });
    const map = { mapX: 50, mapY: 50 } as any;
    updateNpcClientAnimations(client, map, 3);
    for (const id of ids) {
        assert.equal(ecs.getMovementFrameIndex(id), 2);
        assert.equal(ecs.getFrameIndex(id), 2);
    }
    updateNpcClientAnimations(client, map, 1);
    for (const id of ids) {
        assert.equal(ecs.getMovementFrameIndex(id), 0, "movement loops");
        assert.equal(ecs.getSeqId(id), -1, "the completed action stops");
    }
    assert.equal(timingReads, ids.length * 4 * 2, "read only the current movement/action frame per cycle");
    assert.deepEqual(seq.frameLengths, [0, 2, 1], "zero-length frames retain their timing");
});

test("disabled animation smoothing skips per-NPC sequence resolution", async () => {
    (globalThis as any).self = globalThis;
    const { isNpcAnimationSmoothed } = await import("../render/render/anim/npc2");
    let sequenceReads = 0;
    const host = {
        osrsClient: { clientPlugins: { smoothsNpcs: () => false } },
        dynamicNpcAnimLoader: { isReady: () => true },
        resolveNpcMovementSequenceIds: () => { sequenceReads++; },
    } as any;
    for (let id = 1; id <= 256; id++) assert.equal(isNpcAnimationSmoothed(host, id), false);
    assert.equal(sequenceReads, 0);
});

test("a server sequence steps only through the client cycles after the one it arrived in", async () => {
    const { setClientCycleProvider } = await import("../network/ServerConnection");
    const ecs = new NpcEcs();
    const seq = new SeqType(2, { game: "oldschool", revision: 241 } as any);
    seq.frameIds = [1, 2];
    seq.frameLengths = [3, 3];
    const client = {
        npcEcs: ecs,
        playerEcs: {},
        npcTypeLoader: { load: () => ({ getMovementSeqSet: () => ({ idle: 1, walk: 1 }) }) },
        seqTypeLoader: { load: () => seq },
    } as any;
    (ecs as any).seqTypeLoader = client.seqTypeLoader;
    const id = ecs.createNpc(50, 50, 1, 1, 64, 64, 0, 0, 0, 0);
    ecs.setServerMapping(id, 1);
    const map = { mapX: 50, mapY: 50 } as any;
    try {
        // A render frame covering cycles 101..105; the sequence arrived during cycle 103.
        ecs.handleServerSequence(id, 2, 0, 103);
        setClientCycleProvider(() => 105);
        updateNpcClientAnimations(client, map, 5);
        assert.equal(ecs.getFrameIndex(id), 0, "stepped twice (104, 105): still on its first frame");
        assert.equal(ecs.getAnimTick(id), 2);
        // It lasts its full 3 + 3 + 1 cycles from arrival, not cut short by the earlier ones.
        setClientCycleProvider(() => 109);
        updateNpcClientAnimations(client, map, 4);
        assert.equal(ecs.getSeqId(id), 2, "still playing at 109");
        setClientCycleProvider(() => 110);
        updateNpcClientAnimations(client, map, 1);
        assert.equal(ecs.getSeqId(id), -1, "done after 7 cycles");
    } finally {
        setClientCycleProvider(undefined);
    }
});
