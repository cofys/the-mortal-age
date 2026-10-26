import { distanceBetween, UNDEFINED } from "../WorldPointUtil";
import type { PathTransport } from "./PathfinderConfig";

export const NO_NODE = -1;

const FLAG_ABSTRACT = 1 << 1;
const FLAG_DELAYED_VISIT = 1 << 2;
const FLAG_TRANSPORT = 1 << 3;

/** AbstractNodeKind: the global-teleport state for each wilderness bucket that changes which teleports are legal. */
export enum AbstractNodeKind {
    GLOBAL_TELEPORTS_OVER_30 = 0,
    GLOBAL_TELEPORTS_OVER_20 = 1,
    GLOBAL_TELEPORTS_OVER_0 = 2,
    GLOBAL_TELEPORTS_NORMAL = 3,
}
export const ABSTRACT_NODE_KINDS = 4;

export function abstractKindFromWildernessLevel(wildernessLevel: number): AbstractNodeKind {
    if (wildernessLevel > 30) return AbstractNodeKind.GLOBAL_TELEPORTS_OVER_30;
    if (wildernessLevel > 20) return AbstractNodeKind.GLOBAL_TELEPORTS_OVER_20;
    if (wildernessLevel > 0) return AbstractNodeKind.GLOBAL_TELEPORTS_OVER_0;
    return AbstractNodeKind.GLOBAL_TELEPORTS_NORMAL;
}

export function maxWildernessLevelOf(kind: AbstractNodeKind): number {
    switch (kind) {
        case AbstractNodeKind.GLOBAL_TELEPORTS_OVER_30: return 31;
        case AbstractNodeKind.GLOBAL_TELEPORTS_OVER_20: return 30;
        case AbstractNodeKind.GLOBAL_TELEPORTS_OVER_0: return 20;
        default: return 0;
    }
}

/** A path step: the tile, and the transport taken to reach it (its PathTransport index), or -1. */
export type PathStep = { readonly packed: number; readonly transport: number };

/**
 * Shortest Path's NodeGraph: search nodes as int ids into parallel arrays (structure of arrays),
 * not an object per explored tile. Upstream's bank-visit layer is not ported.
 */
export class NodeGraph {
    private packedPosition: Int32Array;
    private previous: Int32Array;
    private cost: Int32Array;
    private differential: Int32Array;
    private flags: Uint8Array;
    private abstractKinds: Uint8Array;
    private transports: (PathTransport | undefined)[] = [];
    size = 0;

    constructor(initialCapacity: number) {
        const capacity = Math.max(1, initialCapacity);
        this.packedPosition = new Int32Array(capacity);
        this.previous = new Int32Array(capacity);
        this.cost = new Int32Array(capacity);
        this.differential = new Int32Array(capacity);
        this.flags = new Uint8Array(capacity);
        this.abstractKinds = new Uint8Array(capacity);
    }

    private ensureCapacity(): void {
        if (this.size < this.packedPosition.length) return;
        const capacity = this.packedPosition.length + (this.packedPosition.length >> 1);
        const grow = <T extends Int32Array | Uint8Array>(array: T, make: (n: number) => T): T => {
            const next = make(capacity);
            next.set(array);
            return next;
        };
        this.packedPosition = grow(this.packedPosition, (n) => new Int32Array(n));
        this.previous = grow(this.previous, (n) => new Int32Array(n));
        this.cost = grow(this.cost, (n) => new Int32Array(n));
        this.differential = grow(this.differential, (n) => new Int32Array(n));
        this.flags = grow(this.flags, (n) => new Uint8Array(n));
        this.abstractKinds = grow(this.abstractKinds, (n) => new Uint8Array(n));
    }

    private append(packed: number, prev: number, nodeCost: number, diffCost: number, flagBits: number, kind: number): number {
        this.ensureCapacity();
        const id = this.size;
        this.packedPosition[id] = packed;
        this.previous[id] = prev;
        this.cost[id] = nodeCost;
        this.differential[id] = diffCost;
        this.flags[id] = flagBits;
        this.abstractKinds[id] = kind;
        this.size = id + 1;
        return id;
    }

    private costOf(id: number): number {
        return id === NO_NODE ? 0 : this.cost[id];
    }

    createStart(packed: number): number {
        return this.append(packed, NO_NODE, 0, 0, 0, 0);
    }

    createTile(packed: number, previous: number): number {
        const travelTime = previous !== NO_NODE && this.isTile(previous)
            ? distanceBetween(this.packedPosition[previous], packed) : 0;
        return this.append(packed, previous, this.costOf(previous) + travelTime, 0, 0, 0);
    }

    createTransport(packed: number, previous: number, travelTime: number, additionalCost: number, delayedVisit: boolean,
        differentialCost: number, transport: PathTransport): number {
        const flagBits = FLAG_TRANSPORT | (delayedVisit ? FLAG_DELAYED_VISIT : 0);
        const id = this.append(packed, previous, this.costOf(previous) + travelTime + additionalCost, differentialCost, flagBits, 0);
        this.transports[id] = transport;
        return id;
    }

    createAbstract(kind: AbstractNodeKind, previous: number): number {
        return this.append(UNDEFINED, previous, this.costOf(previous), 0, FLAG_ABSTRACT, kind);
    }

    packed(id: number): number { return this.packedPosition[id]; }
    nodeCost(id: number): number { return this.cost[id]; }
    differentialCost(id: number): number { return this.differential[id]; }
    compareCost(id: number): number { return this.cost[id] + this.differential[id]; }
    isTile(id: number): boolean { return (this.flags[id] & FLAG_ABSTRACT) === 0; }
    isTransport(id: number): boolean { return (this.flags[id] & FLAG_TRANSPORT) !== 0; }
    isDelayedVisit(id: number): boolean { return (this.flags[id] & FLAG_DELAYED_VISIT) !== 0; }
    abstractKind(id: number): AbstractNodeKind { return this.abstractKinds[id] as AbstractNodeKind; }

    getPathSteps(id: number): PathStep[] {
        const steps: PathStep[] = [];
        for (let node = id; node !== NO_NODE; node = this.previous[node]) {
            if ((this.flags[node] & FLAG_ABSTRACT) === 0) {
                steps.push({ packed: this.packedPosition[node], transport: this.transports[node]?.index ?? -1 });
            }
        }
        return steps.reverse();
    }

    getClosestTilePosition(id: number): number {
        let node = id;
        while (node !== NO_NODE && (this.flags[node] & FLAG_ABSTRACT) !== 0) node = this.previous[node];
        return node !== NO_NODE ? this.packedPosition[node] : UNDEFINED;
    }
}

/** IntMinHeap: node ids ordered by compareCost. */
export class IntMinHeap {
    private heap: Int32Array;
    private count = 0;

    constructor(private readonly graph: NodeGraph, initialCapacity: number) {
        this.heap = new Int32Array(Math.max(1, initialCapacity));
    }

    isEmpty(): boolean { return this.count === 0; }
    peek(): number { return this.count === 0 ? NO_NODE : this.heap[0]; }
    clear(): void { this.count = 0; }

    add(id: number): void {
        if (this.count === this.heap.length) {
            const next = new Int32Array(this.heap.length << 1);
            next.set(this.heap);
            this.heap = next;
        }
        this.heap[this.count] = id;
        this.siftUp(this.count);
        this.count++;
    }

    poll(): number {
        if (this.count === 0) return NO_NODE;
        const top = this.heap[0];
        this.count--;
        if (this.count > 0) {
            this.heap[0] = this.heap[this.count];
            this.siftDown(0);
        }
        return top;
    }

    private siftUp(index: number): void {
        const id = this.heap[index];
        const key = this.graph.compareCost(id);
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (key >= this.graph.compareCost(this.heap[parent])) break;
            this.heap[index] = this.heap[parent];
            index = parent;
        }
        this.heap[index] = id;
    }

    private siftDown(index: number): void {
        const id = this.heap[index];
        const key = this.graph.compareCost(id);
        const half = this.count >> 1;
        while (index < half) {
            let child = (index << 1) + 1;
            let childKey = this.graph.compareCost(this.heap[child]);
            const right = child + 1;
            if (right < this.count) {
                const rightKey = this.graph.compareCost(this.heap[right]);
                if (rightKey < childKey) {
                    child = right;
                    childKey = rightKey;
                }
            }
            if (key <= childKey) break;
            this.heap[index] = this.heap[child];
            index = child;
        }
        this.heap[index] = id;
    }
}

/** IntDeque: the FIFO boundary of unit-cost walking nodes. */
export class IntDeque {
    private items: Int32Array;
    private head = 0;
    private tail = 0;

    constructor(initialCapacity: number) {
        this.items = new Int32Array(Math.max(2, initialCapacity));
    }

    isEmpty(): boolean { return this.head === this.tail; }
    peekFirst(): number { return this.isEmpty() ? NO_NODE : this.items[this.head]; }
    clear(): void { this.head = this.tail = 0; }

    pollFirst(): number {
        if (this.isEmpty()) return NO_NODE;
        const value = this.items[this.head];
        this.head = (this.head + 1) % this.items.length;
        return value;
    }

    addLast(value: number): void {
        this.items[this.tail] = value;
        this.tail = (this.tail + 1) % this.items.length;
        if (this.tail === this.head) this.grow();
    }

    addFirst(value: number): void {
        this.head = (this.head - 1 + this.items.length) % this.items.length;
        this.items[this.head] = value;
        if (this.tail === this.head) this.grow();
    }

    private grow(): void {
        const next = new Int32Array(this.items.length << 1);
        const first = this.items.subarray(this.head);
        next.set(first);
        next.set(this.items.subarray(0, this.tail), first.length);
        this.head = 0;
        this.tail = this.items.length;
        this.items = next;
    }
}
