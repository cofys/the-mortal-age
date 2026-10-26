import type { CollisionMap } from "./CollisionMap";
import type { PathStep } from "./NodeGraph";
import type { PathfinderResult } from "./Pathfinder";
import type { PathSearchBackend, PathSearchListener, PathSearchRequest } from "./PathSearch";

export type ShortestPathWorkerRequest =
    | { type: "init"; collisionMapUrl: string }
    | { type: "search"; id: number; request: PathSearchRequest }
    | { type: "cancel"; id: number };

export type ShortestPathWorkerReply =
    | { type: "ready" }
    | { type: "error"; error: string }
    | { type: "progress"; id: number; path: PathStep[] }
    | { type: "done"; id: number; result: PathfinderResult }
    | { type: "failed"; id: number; error: string };

/** Searches on a Web Worker, so a long route never stalls a frame (upstream's pathfinding executor). */
export class WorkerSearchBackend implements PathSearchBackend {
    readonly ready: Promise<void>;
    private readonly worker: Worker;
    private readonly listeners = new Map<number, PathSearchListener>();
    private nextId = 1;

    constructor(collisionMapUrl: string) {
        // Keep this exact `new Worker(new URL(...))` shape so webpack emits a worker chunk.
        this.worker = new Worker(new URL("./ShortestPathWorker.ts", import.meta.url));
        this.ready = new Promise((resolve, reject) => {
            this.worker.onmessage = (event: MessageEvent<ShortestPathWorkerReply>) => {
                const message = event.data;
                switch (message.type) {
                    case "ready": resolve(); break;
                    case "error": reject(new Error(message.error)); break;
                    case "progress": this.listeners.get(message.id)?.progress(message.path); break;
                    case "done": {
                        const listener = this.listeners.get(message.id);
                        this.listeners.delete(message.id);
                        listener?.done(message.result);
                        break;
                    }
                    case "failed":
                        this.listeners.delete(message.id);
                        console.warn(`[shortest-path] search failed: ${message.error}`);
                        break;
                }
            };
        });
        this.post({ type: "init", collisionMapUrl });
    }

    private post(message: ShortestPathWorkerRequest): void {
        this.worker.postMessage(message);
    }

    map(): CollisionMap | undefined {
        return undefined;
    }

    search(request: PathSearchRequest, listener: PathSearchListener): () => void {
        const id = this.nextId++;
        this.listeners.set(id, listener);
        this.post({ type: "search", id, request });
        return () => {
            if (!this.listeners.delete(id)) return;
            this.post({ type: "cancel", id });
        };
    }

    dispose(): void {
        this.listeners.clear();
        this.worker.terminate();
    }
}
