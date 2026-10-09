import { SparseMemoryStore } from "../store/SparseMemoryStore";

export type Js5CoordinatorMessage = {
    type: "request" | "complete" | "failed";
    indexId: number;
    archiveId: number;
    error?: string;
};

export function isJs5CoordinatorMessage(value: unknown): value is Js5CoordinatorMessage {
    const message = value as Partial<Js5CoordinatorMessage> | undefined;
    return !!message &&
        (message.type === "request" || message.type === "complete" || message.type === "failed") &&
        Number.isInteger(message.indexId) && Number.isInteger(message.archiveId);
}

/** Worker-side proxy for the one JS5 queue owned by the main thread. */
export class WorkerJs5Coordinator {
    private readonly pending = new Map<string, {
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: Error) => void;
    }>();
    private readonly channel: BroadcastChannel;

    constructor(readonly store: SparseMemoryStore, channelName: string) {
        this.channel = new BroadcastChannel(channelName);
        this.channel.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (!isJs5CoordinatorMessage(data) || data.type === "request") return;
            const key = `${data.indexId}:${data.archiveId}`;
            const pending = this.pending.get(key);
            if (!pending) return;
            if (data.type === "failed") {
                this.pending.delete(key);
                pending.reject(new Error(data.error ?? "central JS5 fetch failed"));
                return;
            }
            if (this.store.isGroupPresent(data.indexId, data.archiveId)) {
                this.pending.delete(key);
                pending.resolve();
            }
        };
        store.onMiss = (span) => { void this.requestGroup(span.indexId, span.archiveId); };
    }

    requestGroup(indexId: number, archiveId: number): Promise<void> {
        if (this.store.isGroupPresent(indexId, archiveId)) return Promise.resolve();
        const key = `${indexId}:${archiveId}`;
        const existing = this.pending.get(key);
        if (existing) return existing.promise;
        let resolvePending!: () => void;
        let rejectPending!: (error: Error) => void;
        const promise = new Promise<void>((resolve, reject) => {
            resolvePending = resolve;
            rejectPending = reject;
        });
        promise.catch(() => {});
        this.pending.set(key, { promise, resolve: resolvePending, reject: rejectPending });
        this.channel.postMessage({ type: "request", indexId, archiveId } satisfies Js5CoordinatorMessage);
        return promise;
    }

    /** Resolves requests whose data has become readable here (its dat2 chunk arrived late). */
    recheck(): void {
        for (const [key, pending] of this.pending) {
            const [indexId, archiveId] = key.split(":").map(Number);
            if (!this.store.isGroupPresent(indexId, archiveId)) continue;
            this.pending.delete(key);
            pending.resolve();
        }
    }

    async settled(): Promise<void> {
        await Promise.allSettled(Array.from(this.pending.values(), (pending) => pending.promise));
    }
}
