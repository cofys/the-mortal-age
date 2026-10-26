/* eslint-disable no-restricted-globals */
// The pathfinding thread: holds the collision map and runs one search at a time, posting the
// partial path between slices so the client keeps drawing it, as upstream's render thread does.
import type { CollisionMap } from "./CollisionMap";
import { loadCollisionMap } from "./loadCollisionMap";
import { runSliced, type PathSearchRequest } from "./PathSearch";
import type { ShortestPathWorkerReply, ShortestPathWorkerRequest } from "./WorkerSearchBackend";

const scope = self as unknown as {
    postMessage(message: ShortestPathWorkerReply): void;
    onmessage: ((event: MessageEvent<ShortestPathWorkerRequest>) => void) | null;
};

let map: CollisionMap | undefined;
const searches = new Map<number, () => void>();

function search(id: number, request: PathSearchRequest): void {
    if (!map) {
        scope.postMessage({ type: "failed", id, error: "collision map not loaded" });
        return;
    }
    searches.set(id, runSliced(map, request, {
        progress: (path) => scope.postMessage({ type: "progress", id, path }),
        done: (result) => {
            searches.delete(id);
            scope.postMessage({ type: "done", id, result });
        },
    }));
}

scope.onmessage = (event) => {
    const message = event.data;
    switch (message.type) {
        case "init":
            fetch(message.collisionMapUrl)
                .then((response) => {
                    if (!response.ok) throw new Error(`${message.collisionMapUrl}: HTTP ${response.status}`);
                    return response.arrayBuffer();
                })
                .then(loadCollisionMap)
                .then((loaded) => {
                    map = loaded;
                    scope.postMessage({ type: "ready" });
                })
                .catch((error) => scope.postMessage({ type: "error", error: String(error?.message ?? error) }));
            break;
        case "search":
            search(message.id, message.request);
            break;
        case "cancel":
            searches.get(message.id)?.();
            searches.delete(message.id);
            break;
    }
};
