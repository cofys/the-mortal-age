import assert from "node:assert/strict";

import { GroupMissingError } from "../rs/cache/js5/GroupMissingError";
import { SeqBase } from "../rs/model/seq/SeqBase";
import { Dat2SeqFrameLoader } from "../rs/model/seq/SeqFrameLoader";
import { IndexSkeletalSeqLoader } from "../rs/model/skeletal/SkeletalSeqLoader";

const info: any = { game: "oldschool", revision: 237 };
const archive: any = {
    lastFileId: 1,
    files: [
        { id: 0, data: new Int8Array([0, 1, 0]) },
        { id: 1, data: new Int8Array([0, 2, 0]) },
    ],
};
const available = new Set<number>();
const requested: number[] = [];
const bases = {
    load(id: number) {
        if (!available.has(id)) {
            requested.push(id);
            throw new GroupMissingError(1, id, 0, 520);
        }
        return new SeqBase(id, 0, [], [], new Uint16Array(), []);
    },
    clearCache() {},
};
const loader = new Dat2SeqFrameLoader(info, { getArchive: () => archive } as any, bases);
assert.equal(loader.load(3 << 16), undefined, "missing skeletons leave the animation unavailable");
assert.deepEqual(requested, [1, 2], "one archive pass must request every missing skeleton");
assert.equal(loader.frameMaps.size, 0, "a partial frame map must not be cached");

available.add(1);
requested.length = 0;
assert.equal(loader.load(3 << 16), undefined);
assert.deepEqual(requested, [2]);
assert.equal(loader.frameMaps.size, 0, "decoding one available frame cannot hide another missing frame");

available.add(2);
assert.equal(loader.load((3 << 16) | 1)?.base.id, 2);
assert.equal(loader.load(3 << 16)?.base.id, 1);
assert.equal(loader.frameMaps.size, 1, "cache only the completed archive");

const absent = new Dat2SeqFrameLoader(info, {
    getArchive() { throw new GroupMissingError(0, 3, 0, 520); },
} as any, bases);
assert.equal(absent.load(3 << 16), undefined, "missing animation archives keep their existing retry path");

const corrupt = new Dat2SeqFrameLoader(info, { getArchive: () => archive } as any, {
    load() { throw new Error("corrupt skeleton"); }, clearCache() {},
});
assert.throws(() => corrupt.load(3 << 16), /corrupt skeleton/, "real decoder errors must still propagate");

let skeletalReady = false;
const skeletalIndex: any = { getArchive: () => ({ getFile: () => ({
    data: new Int8Array([1, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
}) }) };
const skeletal = new IndexSkeletalSeqLoader(skeletalIndex, {
    load(id) {
        if (!skeletalReady) throw new GroupMissingError(1, id, 0, 520);
        return new SeqBase(id, 0, [], [], new Uint16Array(), [], { bones: [] } as any);
    }, clearCache() {},
});
assert.equal(skeletal.load(0), undefined, "a missing skeletal base must allow discovery of other loc dependencies");
assert.equal(skeletal.seqs.size, 0);
skeletalReady = true;
assert.equal(skeletal.load(0)?.base.id, 1, "the skeletal animation remains retryable once its base arrives");
assert.equal(skeletal.seqs.size, 1);
const corruptSkeletal = new IndexSkeletalSeqLoader(skeletalIndex, {
    load() { throw new Error("corrupt skeletal base"); }, clearCache() {},
});
assert.throws(() => corruptSkeletal.load(0), /corrupt skeletal base/);
console.log("sparse animation dependency batching passed");
