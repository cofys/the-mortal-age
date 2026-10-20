import assert from "node:assert/strict";
import { test } from "node:test";

import { runWithSparseRetry } from "../game/worker/SparseRetry";

test("worker rebuilds minimap data after a missing terrain chunk arrives", async () => {
    let available = false;
    let misses = 0;
    let attempts = 0;
    const js5 = {
        store: { get missCount() { return misses; } },
        requestGroup: async () => {},
        settled: async () => { available = true; },
    } as any;
    const outcome = { complete: false };

    const result = await runWithSparseRetry(
        { js5 },
        async () => {
            attempts++;
            if (!available) {
                misses++;
                return { minimapBlobs: [] };
            }
            return { minimapBlobs: [new Uint8Array([1, 2, 3])] };
        },
        undefined,
        outcome,
    );

    assert.equal(attempts, 2);
    assert.deepEqual(result.minimapBlobs, [new Uint8Array([1, 2, 3])]);
    assert.equal(outcome.complete, true);
});
