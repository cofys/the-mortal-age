import type { CollisionMap } from "./CollisionMap";
import type { PathStep } from "./NodeGraph";
import { Pathfinder, type PathfinderResult } from "./Pathfinder";
import type { PathfinderConfig, PathTransport } from "./PathfinderConfig";

/** A search request as it crosses to the worker: the config without the map, which the worker holds. */
export type PathSearchRequest = {
    readonly start: number;
    readonly targets: readonly number[];
    /** Every usable transport; origin -1 marks a teleport. */
    readonly transports: readonly PathTransport[];
    readonly transportDestinations: readonly number[];
    readonly avoidWilderness: boolean;
    readonly unreachableTargetDistance: number;
    readonly collisionAwareBlockedTargets: boolean;
    readonly calculationCutoffMillis: number;
};

export type PathSearchListener = {
    /** The best path so far, while the search runs. */
    progress(path: PathStep[]): void;
    done(result: PathfinderResult): void;
};

/** Runs searches over the collision map; upstream's pathfinding executor thread. */
export interface PathSearchBackend {
    /** Settles once the collision map is loaded. */
    readonly ready: Promise<void>;
    /** Starts a search, cancelling none; returns its cancel. */
    search(request: PathSearchRequest, listener: PathSearchListener): () => void;
    /** The collision map, where this backend has it on the main thread (debug drawing). */
    map(): CollisionMap | undefined;
    dispose(): void;
}

export function toPathfinderConfig(map: CollisionMap, request: PathSearchRequest): PathfinderConfig {
    const transports = new Map<number, PathTransport[]>();
    const teleports: PathTransport[] = [];
    for (const transport of request.transports) {
        if (transport.origin === -1) {
            teleports.push(transport);
            continue;
        }
        let list = transports.get(transport.origin);
        if (!list) transports.set(transport.origin, (list = []));
        list.push(transport);
    }
    return {
        map,
        transports,
        teleports,
        transportDestinations: new Set(request.transportDestinations),
        avoidWilderness: request.avoidWilderness,
        unreachableTargetDistance: request.unreachableTargetDistance,
        collisionAwareBlockedTargets: request.collisionAwareBlockedTargets,
        calculationCutoffMillis: request.calculationCutoffMillis,
    };
}

/** How long a slice runs before the partial path is posted and messages are read. */
const SLICE_MILLIS = 40;

/**
 * Runs a search in slices on the current thread's event loop, posting the partial path between
 * them, as upstream's render thread polls the running search. Returns its cancel.
 */
export function runSliced(map: CollisionMap, request: PathSearchRequest, listener: PathSearchListener,
    schedule: (next: () => void) => void = (next) => setTimeout(next, 0)): () => void {
    const pathfinder = new Pathfinder(toPathfinderConfig(map, request), request.start, request.targets);
    let cancelled = false;
    let lastLength = -1;
    const slice = () => {
        if (cancelled) return;
        if (pathfinder.runFor(SLICE_MILLIS)) {
            listener.done(pathfinder.getResult()!);
            return;
        }
        const path = pathfinder.getPath();
        if (path.length !== lastLength) {
            lastLength = path.length;
            listener.progress(path);
        }
        schedule(slice);
    };
    schedule(slice);
    return () => {
        cancelled = true;
        pathfinder.cancel();
    };
}

/** A backend searching on the calling thread (tests, and browsers without Web Workers). */
export class InProcessSearchBackend implements PathSearchBackend {
    readonly ready: Promise<void>;
    private loaded: CollisionMap | undefined;

    constructor(load: () => Promise<CollisionMap>, private readonly synchronous = false) {
        this.ready = load().then((map) => {
            this.loaded = map;
        });
    }

    map(): CollisionMap | undefined {
        return this.loaded;
    }

    search(request: PathSearchRequest, listener: PathSearchListener): () => void {
        const map = this.loaded;
        if (!map) throw new Error("collision map not loaded");
        if (this.synchronous) {
            const pathfinder = new Pathfinder(toPathfinderConfig(map, request), request.start, request.targets);
            listener.done(pathfinder.run());
            return () => {};
        }
        return runSliced(map, request, listener);
    }

    dispose(): void {}
}
