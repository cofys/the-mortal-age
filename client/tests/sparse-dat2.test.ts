import assert from "node:assert/strict";
import { PresenceBitset } from "../rs/cache/js5/PresenceBitset";
import { Sector } from "../rs/cache/store/Sector";
import { SparseDat2 } from "../rs/cache/store/SparseDat2";
import { SparseMemoryStore } from "../rs/cache/store/SparseMemoryStore";

const CHUNK = SparseDat2.CHUNK_BYTES;
assert.equal(CHUNK % Sector.SIZE, 0, "chunks hold whole sectors, so no sector straddles two");

// Nothing is allocated until data lands, and then only the chunks it lands in.
const dat2 = new SparseDat2(CHUNK * 3 + 100, false);
assert.equal(dat2.allocatedBytes, 0, "a fresh dat2 commits no memory");
const created: number[] = [];
dat2.onChunk((index) => created.push(index));
const bytes = new Uint8Array(40).map((_, i) => i + 1);
dat2.write(CHUNK - 20, bytes);
assert.deepEqual(created, [0, 1], "a write across a boundary creates both chunks, announcing each");
assert.equal(dat2.allocatedBytes, CHUNK * 2);
assert.deepEqual(Array.from(dat2.read(CHUNK - 20, 40)), Array.from(bytes), "it reads back across the boundary");
assert.deepEqual(Array.from(dat2.read(CHUNK * 2, 4)), [0, 0, 0, 0], "an absent chunk reads as zero");
assert.equal(dat2.hasRange(CHUNK - 20, 40), true);
assert.equal(dat2.hasRange(CHUNK * 2, 10), false);
dat2.write(CHUNK * 3 + 90, new Uint8Array(50).fill(7));
assert.equal(dat2.chunks[3]!.byteLength, 100, "the last chunk is only as long as the file");
assert.equal(dat2.read(CHUNK * 3 + 99, 1)[0], 7, "and the write stops at the end of the file");

// A render worker's store: the presence bits are shared, but a chunk the main thread created
// after the worker started is only readable once it arrives.
const index = new ArrayBuffer(6);
const entry = new DataView(index);
entry.setUint8(2, 10); // 10-byte group
entry.setUint8(5, 2); // at sector 2
const presence = PresenceBitset.forSectorCount(Math.ceil(dat2.byteLength / Sector.SIZE), false);
const mainStore = new SparseMemoryStore(new SparseDat2(dat2.byteLength, false), [index], presence);
const workerDat2 = SparseDat2.from(JSON.parse(JSON.stringify({ byteLength: dat2.byteLength, shared: false, chunks: [] })));
const workerStore = new SparseMemoryStore(workerDat2, [index], presence);
const sector = new Uint8Array(Sector.SIZE);
sector.set([0, 0, 0, 0, 0, 0, 0, 0], 0); // header: archive 0, part 0, next 0, index 0
sector.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], Sector.HEADER_SIZE);
mainStore.applyRange(2 * Sector.SIZE, sector);
assert.equal(mainStore.isGroupPresent(0, 0), true);
assert.equal(workerStore.isGroupPresent(0, 0), false, "presence alone is not enough without the chunk");
workerDat2.addChunk(0, mainStore.dat2.chunks[0]!);
assert.equal(workerStore.isGroupPresent(0, 0), true, "the arriving chunk makes the group readable");
assert.deepEqual(Array.from(workerStore.read(0, 0)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
console.log("sparse dat2 ok");
