import { decompressStats } from "../../rs/cache/Container";
import { isGroupMissingError } from "../../rs/cache/js5/GroupMissingError";
import type { Js5RangeClient } from "../../rs/cache/js5/Js5RangeClient";

type SparseCache = Pick<Js5RangeClient, "store" | "requestGroup" | "settled">;

/** Rerun sparse-cache builds after missing groups are queued for download or miss counters change. */
export async function runWithSparseRetry<T>(
    workerState: { js5?: SparseCache },
    task: () => Promise<T>,
    profileLabel?: string,
    outcome?: { complete: boolean },
): Promise<T> {
    const js5 = workerState.js5;
    if (!js5) {
        if (outcome) outcome.complete = true;
        return task();
    }
    const store = js5.store;
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts - 1; attempt++) {
        const missesBefore = store.missCount;
        const passStarted = performance.now();
        const decompressBefore = { ...decompressStats };
        try {
            const result = await task();
            if (profileLabel) {
                const gzip = `${Math.round(decompressStats.gzipMs - decompressBefore.gzipMs)}ms/${decompressStats.gzipCount - decompressBefore.gzipCount}`;
                const bzip2 = `${Math.round(decompressStats.bzip2Ms - decompressBefore.bzip2Ms)}ms/${decompressStats.bzip2Count - decompressBefore.bzip2Count}`;
                console.info(`[map-profile] ${profileLabel} pass=${attempt + 1} build=${Math.round(performance.now() - passStarted)}ms misses=${store.missCount - missesBefore} gzip=${gzip} bzip2=${bzip2}`);
            }
            if (store.missCount === missesBefore) {
                if (outcome) outcome.complete = true;
                return result;
            }
            // Non-throwing misses queue their groups while the worker builds; wait, then rerun.
            const waitStarted = performance.now();
            await js5.settled();
            if (profileLabel) console.info(`[map-profile] ${profileLabel} pass=${attempt + 1} cacheWait=${Math.round(performance.now() - waitStarted)}ms`);
        } catch (error) {
            if (!isGroupMissingError(error)) throw error;
            try {
                const waitStarted = performance.now();
                await js5.requestGroup(error.indexId, error.archiveId, true);
                if (profileLabel) console.info(`[map-profile] ${profileLabel} pass=${attempt + 1} blockingGroup=${error.indexId}:${error.archiveId} cacheWait=${Math.round(performance.now() - waitStarted)}ms`);
            } catch (fetchError) {
                // Transient fetch failure; back off so the next attempt can re-queue the group.
                console.warn("[js5] Group fetch failed, retrying task:", fetchError);
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
    }
    // Final pass returns whatever is available after the retry budget is exhausted.
    const missesBefore = store.missCount;
    const result = await task();
    if (outcome) outcome.complete = store.missCount === missesBefore;
    return result;
}
