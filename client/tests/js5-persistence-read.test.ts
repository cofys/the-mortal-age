import assert from "node:assert/strict";

import { openCache } from "../rs/cache/CacheFiles";
import { Js5Persistence } from "../rs/cache/js5/Js5Persistence";
import { Sector } from "../rs/cache/store/Sector";
import { SparseDat2 } from "../rs/cache/store/SparseDat2";

// A CacheStorage shared by every Js5Persistence, like the browser's across sessions.
const entries = new Map<string, { body: ArrayBuffer; headers: [string, string][] }>();
let puts = 0;
const cache = {
    async match(request: string) {
        const entry = entries.get(request);
        return entry && new Response(entry.body.slice(0), { headers: entry.headers });
    },
    async matchAll(request: string) {
        return [...entries].filter(([url]) => url.split("?")[0] === request)
            .map(([, entry]) => new Response(entry.body.slice(0), { headers: entry.headers }));
    },
    async put(request: string, response: Response) {
        puts++;
        entries.set(request, { body: await response.arrayBuffer(), headers: [...response.headers] });
    },
    async delete(request: string) {
        return entries.delete(request);
    },
};
(globalThis as any).caches = { open: async () => cache };

async function idbFallbackKeepsRangeBodiesLazy(): Promise<void> {
    const globals = globalThis as any;
    const original = { caches: globals.caches, indexedDB: globals.indexedDB,
        IDBKeyRange: globals.IDBKeyRange, Response: globals.Response };
    const records = new Map<string, any>();
    const cacheName = "http-range-cache";
    const prefix = "/caches/dat2/range/";
    let denyWrites = false;
    const request = (read: () => unknown, complete?: () => void): any => {
        const result: any = {};
        queueMicrotask(() => {
            result.result = read();
            result.onsuccess?.({ target: result });
            complete?.();
        });
        return result;
    };
    // IndexedDB structured-clones values. Blob payloads stay out of JS ArrayBuffers while
    // the cursor enumerates range headers; legacy records still clone their ArrayBuffers.
    const db = { transaction: () => {
        const tx: any = {};
        tx.objectStore = () => ({
            get: (key: string) => request(() => structuredClone(records.get(key))),
            put: (value: any) => {
                if (denyWrites) throw new Error("storage full");
                return request(() => records.set(value.key, structuredClone(value)), () => tx.oncomplete?.());
            },
            index: () => ({ openCursor: (name: string) => {
                const values = [...records.values()].filter(value => value.cacheName === name);
                const cursorRequest: any = {};
                let index = 0;
                const advance = () => queueMicrotask(() => {
                    cursorRequest.result = index === values.length ? null : {
                        get value() { return structuredClone(values[index]); },
                        continue() { index++; advance(); },
                    };
                    cursorRequest.onsuccess?.({ target: cursorRequest });
                });
                advance();
                return cursorRequest;
            } }),
        });
        return tx;
    } };
    try {
        globals.caches = undefined;
        globals.indexedDB = { open: () => request(() => db) };
        globals.IDBKeyRange = { only: (value: unknown) => value };
        const fallback = await openCache(cacheName);
        const payload = new Uint8Array(512 * 1024).fill(42);
        for (let i = 0; i < 4; i++) {
            await fallback.put(`${prefix}?s=${i}`, new Response(payload, {
                status: 206, statusText: "Partial Content", headers: {
                    "Content-Type": "application/octet-stream", "Range-Start": String(i * payload.byteLength),
                    "Content-Length": String(payload.byteLength),
                },
            }));
        }
        let copiedBytes = 0;
        globals.Response = class extends Response {
            constructor(body?: BodyInit | null, init?: ResponseInit) {
                if (body instanceof ArrayBuffer) copiedBytes += body.byteLength;
                super(body, init);
            }
        };
        const listed = await fallback.matchAll!(prefix, { ignoreSearch: true });
        assert.equal(listed.length, 4);
        assert.equal(copiedBytes, 0, "listing saved range headers must not copy every payload into a Response");
        for (let i = 0; i < listed.length; i++) {
            assert.equal(listed[i].headers.get("Range-Start"), String(i * payload.byteLength));
            assert.equal(listed[i].status, 206);
            assert.equal(listed[i].statusText, "Partial Content");
            assert.deepEqual(new Uint8Array(await listed[i].arrayBuffer()), payload);
        }
        globals.Response = original.Response;
        // Consuming one response must not consume the stored Blob or another response.
        for (let i = 0; i < 2; i++) {
            const hit = await fallback.match(`${prefix}?s=0`);
            assert.equal(hit?.url, `${prefix}?s=0`);
            assert.equal(hit?.headers.get("Content-Type"), "application/octet-stream");
            assert.deepEqual(new Uint8Array(await hit!.arrayBuffer()), payload);
        }
        const legacyUrl = "/legacy-cache-entry";
        records.set(`${cacheName}::${legacyUrl}`, { key: `${cacheName}::${legacyUrl}`, cacheName,
            requestUrl: legacyUrl, body: Uint8Array.of(3, 7, 9).buffer,
            headers: [["X-Legacy", "yes"]], status: 201, statusText: "Created" });
        for (const hit of [await fallback.match(legacyUrl), ...(await fallback.matchAll!(legacyUrl))]) {
            assert.equal(hit?.status, 201);
            assert.equal(hit?.statusText, "Created");
            assert.equal(hit?.headers.get("X-Legacy"), "yes");
            assert.deepEqual([...new Uint8Array(await hit!.arrayBuffer())], [3, 7, 9]);
        }
        denyWrites = true;
        const memoryFallback = await openCache("storage-full");
        await memoryFallback.put("/memory", new Response("still readable", { status: 202 }));
        assert.equal((await memoryFallback.match("/memory"))?.status, 202);
        assert.equal(await (await memoryFallback.match("/memory"))?.text(), "still readable");
        const native = { provider: "CacheStorage" };
        globals.caches = { open: async (name: string) => {
            assert.equal(name, `osrs-typescript::cache::${cacheName}`);
            return native;
        } };
        assert.equal(await openCache(cacheName), native, "secure contexts retain the native CacheStorage provider");
    } finally {
        Object.assign(globals, original);
    }
}

(async () => {
    const dat2 = new SparseDat2(Sector.SIZE * 100, false);
    const bytes = Uint8Array.from({ length: Sector.SIZE * 10 }, (_, i) => i % 251);
    dat2.write(Sector.SIZE * 20, bytes);

    const first = new Js5Persistence("test", "/caches/dat2", dat2);
    first.queue(Sector.SIZE * 20, bytes.byteLength);
    await first.flush();
    assert.equal(puts, 1);

    // The next session restores nothing into memory and reads stored bytes on demand.
    const next = new Js5Persistence("test", "/caches/dat2", new SparseDat2(dat2.byteLength, false));
    assert.deepEqual(await next.read(Sector.SIZE * 22 + 7, 1000), bytes.subarray(Sector.SIZE * 2 + 7, Sector.SIZE * 2 + 1007),
        "a range inside a stored one reads back from storage");
    assert.equal(await next.read(Sector.SIZE * 29, Sector.SIZE * 2), undefined, "a range running past what is stored goes to the network");
    assert.equal(await next.read(0, 10), undefined);

    next.queue(Sector.SIZE * 20, bytes.byteLength);
    await next.flush();
    assert.equal(puts, 1, "a range an earlier session stored is not stored again");

    // Fetch batching can join groups that previous flushes stored separately.
    const more = Uint8Array.from({ length: Sector.SIZE * 10 }, (_, i) => (i + 7) % 239);
    dat2.write(Sector.SIZE * 30, more);
    first.queue(Sector.SIZE * 30, more.byteLength);
    await first.flush();
    dat2.write(Sector.SIZE * 45, more.subarray(0, Sector.SIZE));
    first.queue(Sector.SIZE * 45, Sector.SIZE);
    await first.flush();
    const later = new Js5Persistence("test", "/caches/dat2", new SparseDat2(dat2.byteLength, false));
    const joined = await later.read(Sector.SIZE * 25, Sector.SIZE * 10);
    assert.ok(joined, "a batch spanning adjacent stored ranges reads entirely from storage");
    assert.deepEqual(joined, dat2.read(Sector.SIZE * 25, Sector.SIZE * 10));
    assert.equal(await later.read(Sector.SIZE * 19, Sector.SIZE * 2), undefined, "a gap before stored data still needs the network");
    assert.equal(await later.read(Sector.SIZE * 39, Sector.SIZE * 2), undefined, "a gap after stored data still needs the network");
    assert.equal(await later.read(Sector.SIZE * 39, Sector.SIZE * 7), undefined, "a gap between stored parts still needs the network");

    const stored = entries.get("/caches/dat2/range/?s=30&n=10")!;
    stored.body = stored.body.slice(0, Sector.SIZE);
    assert.equal(await later.read(Sector.SIZE * 25, Sector.SIZE * 10), undefined, "a truncated stored part is never returned as a complete batch");
    entries.delete("/caches/dat2/range/?s=30&n=10");
    assert.equal(await later.read(Sector.SIZE * 25, Sector.SIZE * 10), undefined, "an evicted part falls back to the network");

    (globalThis as any).caches = { open: async () => { throw new Error("storage denied"); } };
    const unavailable = new Js5Persistence("test", "/caches/dat2", dat2);
    assert.equal(await unavailable.read(Sector.SIZE * 20, Sector.SIZE), undefined,
        "unavailable storage must let the caller fetch from the network");
    unavailable.queue(Sector.SIZE * 20, Sector.SIZE);
    await unavailable.flush();
    unavailable.queue(Sector.SIZE * 21, Sector.SIZE);
    await unavailable.flush();
    await idbFallbackKeepsRangeBodiesLazy();
    console.log("js5 persistence read ok");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
