import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { GroupMissingError } from "../rs/cache/js5/GroupMissingError";
import { IndexType } from "../rs/cache/IndexType";
import { WorldMapArea } from "../rs/map/WorldMapArea";
import { WorldMapArchiveRenderer } from "../rs/map/WorldMapArchiveRenderer";

function fixture() {
    const area = new WorldMapArea();
    Object.assign(area, {
        id: 7, internalName: "test", backgroundColor: 0x123456,
        regionLowX: 50, regionHighX: 50, regionLowY: 50, regionHighY: 50,
    });
    // One legacy region, geography group 9/file 0, with no decorations or overlays.
    const composite = Int8Array.from([
        0, 1, 0, 0, 1, 0, 50, 0, 50, 0, 50, 0, 50, 0, 9, 0, 0, 0, 0, 0, 0,
    ]);
    // One underlay tile makes ground colours observable in the rendered result.
    const geography = Int8Array.from([0, 50, 50, 1, 0, 1, ...new Array(4095).fill(0)]);
    const present = new Set([19, 18, 20]);
    const requested: number[] = [];
    const read = (index: number) => {
        requested.push(index);
        if (!present.has(index)) throw new GroupMissingError(index, 9, 0, 520);
    };
    const indexes = {
        [IndexType.OSRS.worldMap]: {
            getArchiveId: () => 1,
            getArchive: () => {
                read(19);
                return { getFileNamed: () => ({ data: composite }) };
            },
        },
        [IndexType.OSRS.worldMapGeography]: {
            getFile: () => { read(18); return { data: geography }; },
        },
        [IndexType.OSRS.worldMapGround]: {
            getArchive: () => {
                read(20);
                return { getFile: () => ({ data: new Int8Array(1) }) };
            },
        },
    };
    const renderer = new WorldMapArchiveRenderer({
        cacheSystem: { getIndex: (id: number) => indexes[id] },
        locTypeLoader: {}, overlayTypeLoader: {}, textureLoader: {}, mapScenes: [],
    } as any);
    // Image decoding is unrelated to sparse-cache readiness and needs a browser canvas.
    (renderer as any).decodeWorldMapSprite = async () => new Int32Array(4096).fill(0xabcdef);
    return { renderer, area, present, requested, indexes };
}

test("cold geography and ground requests start together and finish in the original tile load", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { renderer, area, present, requested } = fixture();
    present.delete(18);
    present.delete(20);
    const pending = renderer.loadTile(area, 50, 50, 1);
    await setImmediate();
    assert.ok(requested.includes(18) && requested.includes(20));
    present.add(18);
    present.add(20);
    t.mock.timers.tick(250);
    const tile = await pending;
    assert.ok(tile, "the caller receives the tile without a 2.5-second image-cache retry");
    assert.equal(tile.width, 64);
    assert.deepEqual([...tile.pixels.slice(63 * 64 * 4, 63 * 64 * 4 + 4)], [0xab, 0xcd, 0xef, 255]);
    assert.strictEqual(await renderer.loadTile(area, 50, 50, 1), tile);
});

test("a composite-map miss is retried instead of being cached as an unavailable area", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { renderer, area, present } = fixture();
    present.delete(19);
    assert.equal(renderer.getIcons(area, 50, 50), undefined);
    const pending = renderer.loadTile(area, 50, 50, 1);
    await setImmediate();
    present.add(19);
    t.mock.timers.tick(250);
    assert.ok(await pending);
});

test("a ground timeout never poisons the rendered tile cache with blank ground", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { renderer, area, present } = fixture();
    present.delete(20);
    const pending = renderer.loadTile(area, 50, 50, 1);
    for (let i = 0; i < 40; i++) {
        await setImmediate();
        t.mock.timers.tick(250);
    }
    assert.equal(await pending, undefined);
    present.add(20);
    const tile = await renderer.loadTile(area, 50, 50, 1);
    assert.ok(tile);
    assert.deepEqual([...tile.pixels.slice(63 * 64 * 4, 63 * 64 * 4 + 4)], [0xab, 0xcd, 0xef, 255]);
});

test("all legacy chunk misses are queued in one attempt", async (t) => {
    const { renderer } = fixture();
    const data1 = [1, 2, 3].map((groupId) => ({ groupId }));
    const requested: number[] = [];
    t.mock.method(renderer as any, "loadWorldMapDataGeography", (data: any) => {
        requested.push(data.groupId);
        throw new GroupMissingError(18, data.groupId, 0, 520);
    });
    assert.throws(() => (renderer as any).loadGeography({ data1, dynamicIcons: [] }), GroupMissingError);
    assert.deepEqual(requested, [1, 2, 3]);
});

test("transferred world-map pixels have one backing allocation and are never reused detached", async () => {
    const { renderer, area } = fixture();
    (renderer as any).options.maxRenderedRegionBytes = 0;
    const rgb = Int32Array.from([0x123456, 0xff0080]);
    const rgba = (renderer as any).convertRgbToRgba(rgb);
    assert.strictEqual(rgba.buffer, rgb.buffer, "convert in place instead of retaining two full tile buffers");
    assert.deepEqual([...rgba], [0x12, 0x34, 0x56, 255, 255, 0, 128, 255]);
    const first = (await renderer.loadTile(area, 50, 50, 1))!;
    const copy = structuredClone(first, { transfer: [first.pixels.buffer] });
    assert.equal(first.pixels.byteLength, 0);
    const second = (await renderer.loadTile(area, 50, 50, 1))!;
    assert.deepEqual(second, copy, "the worker retains geography, not transferred output buffers");
    assert.equal((renderer as any).renderedRegionCache.size, 0);
});

test("cancel and clear stop an awaiting raster without publishing stale pixels", async () => {
    for (const clear of [false, true]) {
        const { renderer, area } = fixture();
        let entered!: () => void, release!: () => void;
        const rasterStarted = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        (renderer as any).options.beforeRaster = () => { entered(); return gate; };
        const pending = renderer.loadTile(area, 50, 50, 1);
        await rasterStarted;
        if (clear) renderer.clear(); else renderer.cancelLoads();
        assert.equal(await pending, undefined, "cancellation releases the request without waiting for the raster slot");
        assert.equal((renderer as any).activeRegions.size, 0);
        assert.equal((renderer as any).renderedRegionCache.size, 0);
        (renderer as any).options.beforeRaster = undefined;
        const next = await renderer.loadTile(area, 50, 50, 1);
        assert.ok(next);
        release();
        await setImmediate();
        assert.strictEqual(await renderer.loadTile(area, 50, 50, 1), next);
    }
});

test("decoded geography and ground caches stay bounded while panning and repair evicted regions", async () => {
    const { renderer, area, indexes } = fixture();
    (renderer as any).options.maxRenderedRegionBytes = 0;
    area.regionHighX = 89;
    const composite = [0, 40];
    for (let x = 50; x <= 89; x++) composite.push(0, 0, 1, 0, x, 0, 50, 0, x, 0, 50, 0, x - 41, 0, 0);
    composite.push(0, 0, 0, 0);
    indexes[19].getArchive = () => ({ getFileNamed: () => ({ data: Int8Array.from(composite) }) });
    indexes[18].getFile = (groupId: number) => ({ data: Int8Array.from([0, groupId + 41, 50, 1, 0, 1, ...new Array(4095).fill(0)]) });
    const tiles = await Promise.all(Array.from({ length: 40 }, (_, i) => renderer.loadTile(area, i + 50, 50, 1)));
    assert.ok(tiles.every(tile => tile?.pixels.length === 64 * 64 * 4));
    const decoded = (renderer as any).areaCache.get(area.id).data0.filter((entry: any) => entry.geographyLoaded);
    assert.equal(decoded.length, 16, "area metadata must not retain arrays evicted from the region LRU");
    assert.ok((renderer as any).decodedRegions.size <= 16);
    assert.ok((renderer as any).groundSpriteCache.size <= 32);
    assert.deepEqual(await renderer.loadTile(area, 50, 50, 1), tiles[0]);
    assert.ok((renderer as any).decodedRegions.size <= 16);
});

test("large legacy chunk regions obey the byte budget without losing rendered output", async () => {
    const { renderer, area, indexes } = fixture();
    (renderer as any).options.maxRenderedRegionBytes = 0;
    const composite = [0, 0, 0, 64];
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
        composite.push(1, 0, 4, 0, 50, 0, 50, x, y, 0, 50, 0, 50, x, y, 0, 9 + x * 8 + y, 0, 0);
    }
    composite.push(0, 0);
    indexes[19].getArchive = () => ({ getFileNamed: () => ({ data: Int8Array.from(composite) }) });
    indexes[18].getFile = (groupId: number) => ({ data: Int8Array.from([
        1, 50, 50, (groupId - 9) >> 3, (groupId - 9) & 7, ...new Array(64).fill(0),
    ]) });
    const tile = await renderer.loadTile(area, 50, 50, 1);
    assert.equal(tile?.pixels.length, 64 * 64 * 4);
    assert.ok((renderer as any).decodedRegionBytes <= 8 * 1024 * 1024,
        "one region can hold 64 large chunk records; a region count alone does not bound memory");
    assert.equal((renderer as any).decodedRegions.size, 0, "oversized input is released after its synchronous raster");
    assert.deepEqual(await renderer.loadTile(area, 50, 50, 1), tile);
});

test("an image decode failure retries instead of caching a blank ground tile", async () => {
    const { renderer, area } = fixture();
    const decode = (renderer as any).decodeWorldMapSprite;
    (renderer as any).decodeWorldMapSprite = async () => undefined;
    assert.equal(await renderer.loadTile(area, 50, 50, 1), undefined);
    (renderer as any).decodeWorldMapSprite = decode;
    const tile = await renderer.loadTile(area, 50, 50, 1);
    assert.ok(tile);
    assert.deepEqual([...tile.pixels.slice(63 * 64 * 4, 63 * 64 * 4 + 4)], [0xab, 0xcd, 0xef, 255]);
});
