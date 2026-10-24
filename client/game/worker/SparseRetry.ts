import { decompressStats } from "../../rs/cache/Container";
import { isGroupMissingError } from "../../rs/cache/js5/GroupMissingError";
import type { Js5RangeClient } from "../../rs/cache/js5/Js5RangeClient";
import type { GroupSpan } from "../../rs/cache/store/SparseMemoryStore";

type SparseCache = Pick<Js5RangeClient, "store" | "requestGroup" | "settled">;

const RETRY_TIMEOUT_MS = 15000;
const GROUP_WAIT_TIMEOUT_MS = 3000;

/** Bound retries without discarding a completed final pass; never publish an incomplete build. */
export async function runWithSparseRetry<T>(
    workerState: { js5?: SparseCache; scenePasses?: number },
    task: () => Promise<T>,
    profileLabel?: string,
    outcome?: { complete: boolean },
    signal?: AbortSignal,
): Promise<T> {
    signal?.throwIfAborted();
    if (outcome) outcome.complete = false;
    const js5 = workerState.js5;
    if (!js5) {
        workerState.scenePasses = (workerState.scenePasses ?? 0) + 1;
        try {
            const result = await task();
            signal?.throwIfAborted();
            if (outcome) outcome.complete = true;
            return result;
        } finally { workerState.scenePasses--; }
    }
    const store = js5.store;
    const missing = new Map<string, Pick<GroupSpan, "indexId" | "archiveId">>();
    const downloaded = new Set<string>();
    const deadline = performance.now() + RETRY_TIMEOUT_MS;
    const timeLeft = () => {
        signal?.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
            throw new Error(`[js5] Incomplete build: retry deadline reached after ${RETRY_TIMEOUT_MS}ms (${[...missing.keys()].join(", ")})`);
        }
        return remaining;
    };
    const onMiss = store.onMiss;
    const onPassMiss = (span: GroupSpan) => {
        missing.set(`${span.indexId}:${span.archiveId}`, span);
        onMiss?.(span);
    };
    let stalled = 0;
    try {
        for (let attempt = 1; ; attempt++) {
            timeLeft();
            missing.clear();
            const missesBefore = store.missCount;
            const passStarted = performance.now();
            const decompressBefore = { ...decompressStats };
            let result!: T;
            let blockingGroup: Pick<GroupSpan, "indexId" | "archiveId"> | undefined;
            workerState.scenePasses = (workerState.scenePasses ?? 0) + 1;
            store.onMiss = onPassMiss;
            try {
                result = await task();
            } catch (error) {
                if (!isGroupMissingError(error)) throw error;
                blockingGroup = error;
                missing.set(`${error.indexId}:${error.archiveId}`, error);
            } finally {
                store.onMiss = onMiss;
                workerState.scenePasses--;
            }
            if (profileLabel) {
                const gzip = `${Math.round(decompressStats.gzipMs - decompressBefore.gzipMs)}ms/${decompressStats.gzipCount - decompressBefore.gzipCount}`;
                const bzip2 = `${Math.round(decompressStats.bzip2Ms - decompressBefore.bzip2Ms)}ms/${decompressStats.bzip2Count - decompressBefore.bzip2Count}`;
                console.info(`[map-profile] ${profileLabel} pass=${attempt} build=${Math.round(performance.now() - passStarted)}ms misses=${store.missCount - missesBefore} gzip=${gzip} bzip2=${bzip2}`);
            }
            signal?.throwIfAborted();
            if (!blockingGroup && store.missCount === missesBefore) {
                if (outcome) outcome.complete = true;
                return result;
            }

            const waitStarted = performance.now();
            const waitMs = Math.min(GROUP_WAIT_TIMEOUT_MS, timeLeft());
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let abort: (() => void) | undefined;
            try {
                // Worker coordinator replies can be lost; keep that wait bounded too.
                await Promise.race([
                    new Promise<never>((_, reject) => {
                        abort = () => reject(signal?.reason);
                        signal?.addEventListener("abort", abort, { once: true });
                    }),
                    blockingGroup
                        ? js5.requestGroup(blockingGroup.indexId, blockingGroup.archiveId, true)
                        : js5.settled(),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new Error("Cache group download timed out")), waitMs);
                    }),
                ]);
            } catch (fetchError) {
                signal?.throwIfAborted();
                console.warn("[js5] Group fetch failed, retrying task:", fetchError);
            } finally {
                clearTimeout(timeout);
                if (abort) signal?.removeEventListener("abort", abort);
            }
            if (profileLabel) console.info(`[map-profile] ${profileLabel} pass=${attempt} cacheWait=${Math.round(performance.now() - waitStarted)}ms`);
            timeLeft();

            let progress = false;
            for (const [key, group] of missing) {
                if (!downloaded.has(key) && store.isGroupPresent(group.indexId, group.archiveId)) {
                    downloaded.add(key);
                    progress = true;
                }
            }
            if (progress) stalled = 0;
            else {
                if (++stalled >= 8) {
                    throw new Error(`[js5] Incomplete build: no download progress after ${stalled} attempts (${[...missing.keys()].join(", ")})`);
                }
                const delay = Math.min(250, timeLeft());
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    } finally {
        store.onMiss = onMiss;
    }
}
