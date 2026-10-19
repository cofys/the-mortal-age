import assert from "node:assert/strict";
import { test } from "node:test";

import { DynamicNpcAnimLoader } from "../render/npc/DynamicNpcAnimLoader";
import { Model } from "../rs/model/Model";
import { SeqType } from "../rs/config/seqtype/SeqType";

test("identical NPC appearances share posed geometry without sharing their identity", () => {
    const types = new Map<number, any>();
    const base = {
        modelIds: [100], widthScale: 128, heightScale: 128, ambient: 0, contrast: 0,
    };
    for (let id = 1; id <= 59; id++) {
        types.set(id, { ...base, id, modelIds: [100 + id % 5] });
    }
    const seq = new SeqType(1, { game: "oldschool", revision: 241 } as any);
    seq.frameIds = [1, 2];
    seq.frameLengths = [2, 2];
    const loader = new DynamicNpcAnimLoader(
        { load: (id: number) => types.get(id) } as any,
        undefined, {} as any,
        { load: () => seq } as any,
        { load: () => ({}) } as any,
        undefined, {} as any,
    );
    const model = new Model();
    model.verticesCount = 3;
    model.faceCount = 1;
    model.verticesX = new Int32Array([0, 128, 0]);
    model.verticesY = new Int32Array([0, 0, -128]);
    model.verticesZ = new Int32Array(3);
    model.indices1 = new Int32Array([0]);
    model.indices2 = new Int32Array([1]);
    model.indices3 = new Int32Array([2]);
    model.faceColors1 = model.faceColors2 = model.faceColors3 = new Int32Array([100]);
    const modelCache = new Map();
    (loader as any).npcModelLoader = {
        modelCache,
        getModel: (type: any) => { modelCache.set(type.id, model); return model; },
    };
    loader.setTextureIdIndexMap(new Map());

    const poses = Array.from(types.keys(), (id) => loader.getFrameGeometry(id, 1, 0)!);
    assert.equal(loader.getStats().geometryEntries, 5, "59 types only pack five identical poses");
    for (let i = 0; i < poses.length; i++) {
        assert.equal(poses[i].npcTypeId, i + 1, "NPC IDs remain distinct");
        assert.ok(poses[i].opaqueIndices.length > 0);
        if (i >= 5) {
            assert.equal(poses[i].key, poses[i - 5].key, "GPU buffers can share the same key");
            assert.equal(poses[i].opaqueVertices, poses[i - 5].opaqueVertices);
        }
    }
    assert.notEqual(loader.getFrameGeometry(1, 1, 1)!.key, poses[0].key, "frames remain distinct");
    assert.notEqual(loader.getFrameGeometry(1, 1, 0, 2, 1)!.key, poses[0].key, "overlay poses remain distinct");

    for (const changes of [
        { modelIds: [999] }, { widthScale: 140 }, { heightScale: 140 },
        { ambient: 10 }, { contrast: 5 },
        { recolorFrom: [100], recolorTo: [200] },
        { retextureFrom: [1], retextureTo: [2] },
    ]) {
        const id = types.size + 1;
        types.set(id, { ...types.get(1), ...changes, id });
        assert.notEqual(loader.getFrameGeometry(id, 1, 0)!.key, poses[0].key,
            "different models, scales, lighting and recolors must not share a pose");
    }
    const baseA = loader.getBaseGeometry(1)!;
    const baseB = loader.getBaseGeometry(6)!;
    assert.equal(baseA.opaqueVertices, baseB.opaqueVertices);
    assert.equal(baseB.npcTypeId, 6);
    loader.clear();
    assert.equal(loader.getStats().geometryEntries, 0);
});
