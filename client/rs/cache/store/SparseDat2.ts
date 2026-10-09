import { Sector } from "./Sector";

type ChunkListener = (index: number, chunk: ArrayBuffer) => void;

/** What survives a structured clone of a SparseDat2 (its prototype and listeners do not). */
export type SparseDat2Data = { byteLength: number; shared: boolean; chunks: (ArrayBuffer | undefined)[] };

/**
 * The dat2 of a sparse cache, allocated as sector-aligned chunks only once data lands in them.
 * A whole-file buffer is committed in full on creation (Windows, and so an Xbox, counts that
 * against the tab's memory limit) though most of the cache is fetched on demand, or never.
 * Chunks are shared buffers when the page is cross-origin isolated; a new chunk is announced to
 * listeners (the render worker pool) so every context reads the same memory.
 */
export class SparseDat2 {
    /** A whole number of sectors, so no sector straddles two chunks (about 1 MB). */
    static readonly CHUNK_BYTES = Sector.SIZE * 2048;

    readonly #listeners = new Set<ChunkListener>();

    constructor(
        readonly byteLength: number,
        readonly shared: boolean,
        readonly chunks: (ArrayBuffer | undefined)[] = [],
    ) {}

    /** Rebuilds the class around a structured clone of one (a render worker's copy). */
    static from(data: SparseDat2Data): SparseDat2 {
        return new SparseDat2(data.byteLength, data.shared, data.chunks);
    }

    /** Calls `listener` for every chunk this context creates; returns the unsubscribe. */
    onChunk(listener: ChunkListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** A chunk another context created. */
    addChunk(index: number, chunk: ArrayBuffer): void {
        this.chunks[index] ??= chunk;
    }

    get allocatedBytes(): number {
        return this.chunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0);
    }

    /** Whether every chunk covering [offset, offset + length) exists here. */
    hasRange(offset: number, length: number): boolean {
        const last = Math.floor((Math.min(offset + length, this.byteLength) - 1) / SparseDat2.CHUNK_BYTES);
        for (let index = Math.floor(offset / SparseDat2.CHUNK_BYTES); index <= last; index++) {
            if (!this.chunks[index]) return false;
        }
        return true;
    }

    /** The bytes at [offset, offset + length) inside one chunk (one sector at most). */
    view(offset: number, length: number): Int8Array | undefined {
        const index = Math.floor(offset / SparseDat2.CHUNK_BYTES);
        const chunk = this.chunks[index];
        const local = offset - index * SparseDat2.CHUNK_BYTES;
        if (!chunk || local + length > chunk.byteLength) return undefined;
        return new Int8Array(chunk, local, length);
    }

    /** Writes `bytes` at `offset`, creating the chunks it lands in. */
    write(offset: number, bytes: Uint8Array): void {
        let written = 0;
        while (written < bytes.byteLength && offset + written < this.byteLength) {
            const position = offset + written;
            const index = Math.floor(position / SparseDat2.CHUNK_BYTES);
            const chunk = this.chunk(index);
            const local = position - index * SparseDat2.CHUNK_BYTES;
            const take = Math.min(bytes.byteLength - written, chunk.byteLength - local);
            new Uint8Array(chunk).set(bytes.subarray(written, written + take), local);
            written += take;
        }
    }

    /** A copy of [offset, offset + length); bytes in absent chunks read as zero. */
    read(offset: number, length: number): Uint8Array<ArrayBuffer> {
        const out = new Uint8Array(Math.max(0, Math.min(length, this.byteLength - offset)));
        let copied = 0;
        while (copied < out.byteLength) {
            const position = offset + copied;
            const index = Math.floor(position / SparseDat2.CHUNK_BYTES);
            const local = position - index * SparseDat2.CHUNK_BYTES;
            const chunkLength = Math.min(SparseDat2.CHUNK_BYTES, this.byteLength - index * SparseDat2.CHUNK_BYTES);
            const take = Math.min(out.byteLength - copied, chunkLength - local);
            const chunk = this.chunks[index];
            if (chunk) out.set(new Uint8Array(chunk, local, take), copied);
            copied += take;
        }
        return out;
    }

    private chunk(index: number): ArrayBuffer {
        const existing = this.chunks[index];
        if (existing) return existing;
        const size = Math.min(SparseDat2.CHUNK_BYTES, this.byteLength - index * SparseDat2.CHUNK_BYTES);
        const chunk = (this.shared ? new SharedArrayBuffer(size) : new ArrayBuffer(size)) as ArrayBuffer;
        this.chunks[index] = chunk;
        for (const listener of this.#listeners) listener(index, chunk);
        return chunk;
    }
}
