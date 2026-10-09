import assert from "node:assert/strict";

import { SparseDat2 } from "../rs/cache/store/SparseDat2";
import { prefetchIndexRegions, startSparsePrefetch } from "../game/Caches";
import { PresenceBitset } from "../rs/cache/js5/PresenceBitset";
import { Sector } from "../rs/cache/store/Sector";
import { SectorCluster } from "../rs/cache/store/SectorCluster";

const CHUNK_SECTORS = Math.ceil((512 * 1024) / Sector.SIZE);

/** An idx file whose single group covers [startSector, startSector + sectors). */
function idxFile(startSector: number, sectors: number): ArrayBuffer {
    const buf = new ArrayBuffer(SectorCluster.SIZE);
    const u8 = new Uint8Array(buf);
    const size = sectors * Sector.DATA_SIZE;
    u8[0] = (size >> 16) & 0xff;
    u8[1] = (size >> 8) & 0xff;
    u8[2] = size & 0xff;
    u8[3] = (startSector >> 16) & 0xff;
    u8[4] = (startSector >> 8) & 0xff;
    u8[5] = startSector & 0xff;
    return buf;
}

type Range = { start: number; end: number };

/** Stubs fetch with a Range-honouring server; returns the ranges it served. */
function stubFetch(totalSize: number, fill: number): Range[] {
    const served: Range[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (
        _url: RequestInfo | URL,
        init?: RequestInit,
    ) => {
        const header = (init?.headers as Record<string, string>).Range;
        const match = /bytes=(\d+)-(\d+)/.exec(header);
        assert.ok(match, `unparseable Range header: ${header}`);
        const start = Number(match[1]);
        const endExclusive = Number(match[2]) + 1;
        served.push({ start, end: endExclusive });
        return new Response(new Uint8Array(endExclusive - start).fill(fill), {
            status: 206,
            headers: {
                "Content-Range": `bytes ${start}-${endExclusive - 1}/${totalSize}`,
            },
        });
    }) as typeof fetch;
    return served;
}

async function prefetchChunksAndMarksPresence(): Promise<void> {
    // One index spanning 10MB -> must split into short background chunks.
    const startSector = 100;
    const regionSectors = Math.ceil((10 * 1024 * 1024) / Sector.SIZE);
    const totalSize = (startSector + regionSectors + 50) * Sector.SIZE;

    const buffer = new SparseDat2(totalSize, false);
    const presence = PresenceBitset.forSectorCount(Math.ceil(totalSize / Sector.SIZE), false);
    const queued: Range[] = [];
    const served = stubFetch(totalSize, 0xab);

    await prefetchIndexRegions(
        "cache.dat2",
        buffer,
        totalSize,
        presence,
        { queue: (byteOffset, byteLength) => queued.push({ start: byteOffset, end: byteLength }) },
        new Map([[7, idxFile(startSector, regionSectors)]]),
        [7],
    );

    assert.equal(served.length, Math.ceil(regionSectors / CHUNK_SECTORS), "chunk count");
    for (const range of served) {
        assert.ok(
            range.end - range.start <= CHUNK_SECTORS * Sector.SIZE,
            `chunk ${range.start}-${range.end} exceeds the 4MB budget`,
        );
    }
    // Contiguous cover of exactly the index region, no gaps and no overlap.
    assert.equal(served[0].start, startSector * Sector.SIZE);
    for (let i = 1; i < served.length; i++) {
        assert.equal(served[i].start, served[i - 1].end, "chunks must be contiguous");
    }
    assert.equal(served[served.length - 1].end, (startSector + regionSectors) * Sector.SIZE);

    // Bytes landed in the buffer, presence marked, persistence queued.
    assert.equal(buffer.read(startSector * Sector.SIZE, 1)[0], 0xab);
    assert.ok(presence.hasSectors(startSector, regionSectors), "region marked present");
    assert.ok(!presence.hasSectors(startSector - 1, 1), "must not mark outside the region");
    assert.equal(queued.length, served.length, "every chunk queued for persistence");
}

async function skipsChunksAlreadyPresent(): Promise<void> {
    // Sector 0 is the dat2 header, so a group never starts there.
    const startSector = 8;
    const regionSectors = CHUNK_SECTORS * 3;
    const totalSize = (startSector + regionSectors + 10) * Sector.SIZE;

    const buffer = new SparseDat2(totalSize, false);
    const presence = PresenceBitset.forSectorCount(Math.ceil(totalSize / Sector.SIZE), false);
    // A previous session already stored the middle chunk.
    presence.markSectors(startSector + CHUNK_SECTORS, CHUNK_SECTORS);
    const served = stubFetch(totalSize, 0xcd);

    await prefetchIndexRegions(
        "cache.dat2",
        buffer,
        totalSize,
        presence,
        { queue: () => {} },
        new Map([[7, idxFile(startSector, regionSectors)]]),
        [7],
    );

    assert.equal(served.length, 2, "already-present chunk must not be refetched");
    assert.equal(served[0].start, startSector * Sector.SIZE);
    assert.equal(served[1].start, (startSector + 2 * CHUNK_SECTORS) * Sector.SIZE);
}

async function abortStopsMidRegion(): Promise<void> {
    const startSector = 8;
    const regionSectors = CHUNK_SECTORS * 3;
    const totalSize = (startSector + regionSectors + 10) * Sector.SIZE;
    const buffer = new SparseDat2(totalSize, false);
    const presence = PresenceBitset.forSectorCount(Math.ceil(totalSize / Sector.SIZE), false);
    const served = stubFetch(totalSize, 0x01);
    const controller = new AbortController();

    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url, init) => {
        controller.abort();
        return realFetch(url, init);
    }) as typeof fetch;

    await prefetchIndexRegions(
        "cache.dat2",
        buffer,
        totalSize,
        presence,
        { queue: () => {} },
        new Map([[7, idxFile(startSector, regionSectors)]]),
        [7],
        controller.signal,
    );

    assert.equal(served.length, 1, "aborting must stop after the in-flight chunk");
}

async function ignoresRegionsBeyondTheFile(): Promise<void> {
    const totalSize = 100 * Sector.SIZE;
    const buffer = new SparseDat2(totalSize, false);
    const presence = PresenceBitset.forSectorCount(Math.ceil(totalSize / Sector.SIZE), false);
    const served = stubFetch(totalSize, 0x02);

    await prefetchIndexRegions(
        "cache.dat2",
        buffer,
        totalSize,
        presence,
        { queue: () => {} },
        // Region runs off the end of the dat2 (corrupt idx / HTML error page).
        new Map([[7, idxFile(90, 500)]]),
        [7],
    );

    assert.equal(served.length, 0, "out-of-range index region must be skipped");
}

async function main(): Promise<void> {
    // Caches without a deferred prefetch must be harmless at the gameplay gate.
    startSparsePrefetch(undefined);
    await prefetchChunksAndMarksPresence();
    await skipsChunksAlreadyPresent();
    await abortStopsMidRegion();
    await ignoresRegionsBeyondTheFile();
    console.log("cache-prefetch tests passed");
}

void main();
