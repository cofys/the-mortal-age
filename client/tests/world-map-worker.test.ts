import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { WorldMapTileJob } from "../game/worker/WorldMapTileJob";
import { WorldMapController } from "../game/worldMap/WorldMapController";

(globalThis as any).self = globalThis;
const { RenderDataWorkerPool } = require("../game/worker/RenderDataWorkerPool");
const input = { area: { id: 1, internalName: "test", backgroundColor: 0, regionLowX: 1, regionHighX: 1,
    regionLowY: 1, regionHighY: 1 }, mapX: 1, mapY: 1, pixelsPerTile: 1 };

test("a single cache worker starts concurrent cold tiles and reports cancellation/disposal as idle", async () => {
    const pending: Array<{ input: any; resolve: (reply: any) => void }> = [];
    const cancels: number[] = [];
    const worker = {
        loadWorldMapTile: (input: any) => new Promise(resolve => pending.push({ input, resolve })),
        cancelWorldMapTiles: (epoch: number) => { cancels.push(epoch); },
    };
    let terminated = false;
    const pool = new RenderDataWorkerPool({ terminate: async () => { terminated = true; } }, [{ init: Promise.resolve(worker) }], 1);
    const first = Array.from({ length: 15 }, () => pool.loadWorldMapTile(input));
    await setImmediate();
    assert.equal(pending.length, 15, "cold JS5 reads must overlap rather than waiting for the previous tile");
    assert.equal(pool.pendingWorldMapTiles, 15);
    pool.cancelWorldMapTiles();
    assert.ok((await Promise.all(first)).every(reply => reply.supported && !reply.tile));
    assert.equal(pool.pendingWorldMapTiles, 0);
    const current = pool.loadWorldMapTile(input);
    await setImmediate();
    for (const old of pending.slice(0, 15)) old.resolve({ supported: true, tile: { pixels: new Uint8Array(4) } });
    await setImmediate();
    assert.equal(pool.pendingWorldMapTiles, 1, "stale completions cannot remove the new request");
    assert.equal(pending[15].input.epoch, cancels[0]);
    pending[15].resolve({ supported: true });
    await current;
    await setImmediate();
    const stopped = pool.loadWorldMapTile(input);
    await pool.terminate();
    assert.equal((await stopped).tile, undefined);
    assert.equal(pool.pendingWorldMapTiles, 0);
    assert.equal(terminated, true);
    await assert.rejects(pool.loadWorldMapTile(input), /disposed/);
});

test("worker raster requests use separate vars and cannot return after reset/disposal", async () => {
    const previous = { canvas: (globalThis as any).OffscreenCanvas, bitmap: (globalThis as any).createImageBitmap };
    (globalThis as any).OffscreenCanvas = class { getContext() { return {}; } };
    (globalThis as any).createImageBitmap = async () => ({});
    try {
        const values = new Int32Array(8000);
        const state: any = { varManager: { values }, cacheLoaderFactory: { getVarBitTypeLoader: () => ({}) } };
        const jobs = new WorldMapTileJob(state);
        let signal!: AbortSignal, release!: () => void, clears = 0;
        const renderer = { clear: () => clears++, loadTile: (_a: unknown, _x: number, _y: number, _s: number, s: AbortSignal) => {
            signal = s;
            return new Promise(resolve => { release = () => resolve({ pixels: new Uint8Array(4) }); });
        } };
        (jobs as any).renderer = renderer;
        const request = jobs.load({ ...input, epoch: 0 });
        await setImmediate();
        jobs.cancel(1, true);
        assert.equal(signal.aborted, true);
        release();
        assert.equal((await request).tile, undefined);
        assert.equal(clears, 1);
        assert.equal((await jobs.load({ ...input, epoch: 0 })).tile, undefined);
        const updated = values.slice(); updated[10] = 7;
        jobs.setVars(updated);
        assert.equal((jobs as any).vars.getVarp(10), 7);
        assert.equal(values[10], 0, "world-map transforms cannot change a geometry job's var snapshot");
        jobs.dispose();
        assert.equal((await jobs.load({ ...input, epoch: 1 })).tile, undefined);
    } finally {
        if (previous.canvas === undefined) delete (globalThis as any).OffscreenCanvas;
        else (globalThis as any).OffscreenCanvas = previous.canvas;
        if (previous.bitmap === undefined) delete (globalThis as any).createImageBitmap;
        else (globalThis as any).createImageBitmap = previous.bitmap;
    }
});

test("the main raster fallback is lazy and only used when worker image APIs are unsupported", async () => {
    let supported = true, mainLoads = 0, initializations = 0;
    const pool = { pendingWorldMapTiles: 0, cancelWorldMapTiles() {},
        loadWorldMapTile: async () => ({ supported }) };
    const controller = new WorldMapController({ getWorkerPool: () => pool,
        getMinimapImageKey: () => 0, getWidgetManager: () => undefined } as any);
    (controller as any).createFallbackRenderer = () => {
        initializations++;
        return { loadTile: async () => { mainLoads++; return undefined; } };
    };
    controller.initArchiveRenderer();
    const renderer = (controller as any).worldMapArchiveRenderer;
    await renderer.loadTile(input.area, 1, 1, 1);
    assert.equal(initializations, 0, "an incomplete worker tile must retry rather than silently rasterizing on main");
    supported = false;
    await renderer.loadTile(input.area, 1, 1, 1);
    await renderer.loadTile(input.area, 1, 1, 1);
    assert.equal(initializations, 1);
    assert.equal(mainLoads, 2);
    pool.pendingWorldMapTiles = 1;
    assert.equal(controller.hasPendingImages(), true);
});
