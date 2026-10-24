import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerInputUpdates } from "../game/worker/WorkerInputUpdates";
import { recordVarReads, trackVarReads, varReadsMatch } from "../game/worker/MapSquareCache";
import { VarManager } from "../rs/config/vartype/VarManager";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("yielding geometry retains one var snapshot and records matching cache dependencies", async () => {
    const updates = new WorkerInputUpdates();
    const vars = new VarManager({ load: () => undefined } as any);
    vars.set(Int32Array.of(1));
    trackVarReads(vars);
    const release = updates.hold();
    let resume!: () => void;
    const yielded = new Promise<void>(resolve => { resume = resolve; });
    const geometry = recordVarReads(async () => {
        const firstChunk = vars.getVarp(0);
        await yielded;
        return [firstChunk, vars.getVarp(0)];
    });
    let obsoleteApplied = false, acknowledged = false;
    const first = updates.update("vars", () => { obsoleteApplied = true; vars.set(Int32Array.of(2)); });
    const latest = updates.update("vars", () => vars.set(Int32Array.of(3)));
    void latest.then(() => { acknowledged = true; });
    await turn();
    assert.equal(acknowledged, false, "setVars must not acknowledge an unapplied snapshot");
    resume();
    const built = await geometry;
    assert.deepEqual(built.result, [1, 1], "all chunks use the inputs from build start");
    assert.deepEqual(built.reads, [[1, 0, 1]], "cache dependencies describe the actual geometry");
    assert.equal(varReadsMatch(vars, built.reads), true);
    release();
    await Promise.all([first, latest]);
    assert.equal(obsoleteApplied, false, "ticks replace queued snapshots instead of growing a backlog");
    assert.equal(vars.getVarp(0), 3);
    assert.equal(varReadsMatch(vars, built.reads), false, "new vars cannot reuse the old geometry as if it were rebuilt");
});

test("NPC snapshots coalesce while distinct content payloads retain their order", async () => {
    const updates = new WorkerInputUpdates();
    const release = updates.hold(), releaseNested = updates.hold();
    const applied: string[] = [];
    const pending = [
        updates.update("npcs", () => { applied.push("old NPCs"); }),
        updates.update("npcs", () => { applied.push("latest NPCs"); }),
        updates.update(Symbol(), () => { applied.push("items"); }),
        updates.update(Symbol(), () => { applied.push("terrain"); }),
    ];
    releaseNested();
    assert.deepEqual(applied, [], "a nested minimap repair cannot release its parent build's inputs");
    release();
    await Promise.all(pending);
    assert.deepEqual(applied, ["latest NPCs", "items", "terrain"]);
    await updates.update("vars", () => { applied.push("next vars"); });
    assert.equal(applied.at(-1), "next vars", "idle setters still apply immediately");
});

test("failed or cancelled builds flush deferred updates and one bad update cannot strand the rest", async () => {
    const updates = new WorkerInputUpdates();
    const release = updates.hold();
    let applied = false;
    const failed = assert.rejects(updates.update(Symbol(), () => { throw Error("invalid content"); }), /invalid content/);
    const next = updates.update("vars", () => { applied = true; });
    await assert.rejects((async () => {
        try { await turn(); throw new DOMException("cancelled", "AbortError"); }
        finally { release(); }
    })(), { name: "AbortError" });
    await Promise.all([failed, next]);
    assert.equal(applied, true);
});

test("deferred callbacks from a replaced cache cannot restore its custom content", async () => {
    const updates = new WorkerInputUpdates();
    let statePromise = Promise.resolve("old cache");
    const oldStatePromise = statePromise;
    const release = updates.hold();
    let content = "initial";
    const old = updates.update(Symbol(), () => {
        if (oldStatePromise !== statePromise) return;
        content = "obsolete content";
    });
    statePromise = Promise.resolve("new cache");
    content = "new cache content";
    release();
    await old;
    assert.equal(content, "new cache content");
});
