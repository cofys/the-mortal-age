import {
    distanceBetween,
    EUCLIDEAN_SQUARED_DISTANCE_METRIC,
    MANHATTAN_DISTANCE_METRIC,
    UNDEFINED,
    unpackWorldX,
    unpackWorldY,
} from "../WorldPointUtil";
import { avoidWilderness, type CollisionMap } from "./CollisionMap";
import { IntDeque, IntMinHeap, NO_NODE, NodeGraph, type PathStep } from "./NodeGraph";
import type { PathfinderConfig } from "./PathfinderConfig";
import { TargetGoals } from "./TargetGoals";
import { VisitedTiles } from "./VisitedTiles";
import { anyInWilderness, isInLevel20Wilderness, isInLevel30Wilderness, isInWilderness } from "./WildernessChecker";

export type PathTerminationReason = "TARGET_REACHED" | "CUTOFF_REACHED" | "SEARCH_EXHAUSTED" | "CANCELLED";

export type PathfinderResult = {
    readonly start: number;
    readonly reached: boolean;
    readonly target: number;
    readonly path: PathStep[];
    readonly cost: number;
    readonly nodesChecked: number;
    readonly transportsChecked: number;
    readonly elapsedMillis: number;
    readonly terminationReason: PathTerminationReason;
};

const INT_MAX = 2147483647;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Shortest Path's legacy Pathfinder (the default backend): a breadth-first search over walking
 * tiles, with transports on a cost-ordered heap that wins ties, so a transport strictly cheaper
 * than walking claims its destination first. Runs in slices (`runFor`) so a Web Worker can post
 * the partial path and take a cancel between them. The bank-visit layer is not ported.
 */
export class Pathfinder {
    readonly targets: ReadonlySet<number>;
    private readonly map: CollisionMap;
    private readonly goals: TargetGoals;
    private readonly hasViableGoal: boolean;
    private readonly graph = new NodeGraph(1 << 14);
    private readonly boundary = new IntDeque(4096);
    private readonly pending: IntMinHeap;
    private readonly visited: VisitedTiles;
    private readonly targetInWilderness: boolean;
    private started = false;
    private startTime = 0;
    private lastProgress = 0;
    private finished = false;
    private cancelled = false;
    private bestLastNode = NO_NODE;
    private bestRemainingDistance = INT_MAX;
    private bestTravelledDistance = INT_MAX;
    private bestX = INT_MAX;
    private bestY = INT_MAX;
    private shortestAcceptedNode = NO_NODE;
    private shortestAcceptedTarget = UNDEFINED;
    private reachedTarget = UNDEFINED;
    private terminationReason: PathTerminationReason | null = null;
    private nodesChecked = 0;
    private transportsChecked = 0;
    private result: PathfinderResult | null = null;
    /**
     * Teleports allowed here: 0 all (e.g. Chronicle), 20 most (e.g. Varrock Teleport), 30 some
     * (e.g. Amulet of glory), 31 none.
     */
    private wildernessLevel = 31;

    constructor(private readonly config: PathfinderConfig, readonly start: number, targets: Iterable<number>) {
        this.targets = new Set(targets);
        this.map = config.map;
        this.goals = TargetGoals.resolve(config, start, this.targets);
        this.hasViableGoal = this.goals.hasViableGoal();
        this.pending = new IntMinHeap(this.graph, 256);
        this.visited = new VisitedTiles(this.map.flags);
        this.targetInWilderness = anyInWilderness(this.targets);
    }

    isDone(): boolean { return this.finished; }

    cancel(): void { this.cancelled = true; }

    /** Runs the whole search. */
    run(): PathfinderResult {
        while (!this.runFor(Infinity));
        return this.result!;
    }

    /** Searches for up to `millis`; true once finished. */
    runFor(millis: number): boolean {
        if (this.finished) return true;
        if (!this.started) {
            this.started = true;
            this.startTime = this.lastProgress = now();
            this.boundary.addFirst(this.graph.createStart(this.start));
        }
        const sliceEnd = now() + millis;
        let checks = 0;
        while (!this.cancelled && this.hasViableGoal && (!this.boundary.isEmpty() || !this.pending.isEmpty())) {
            if ((++checks & 1023) === 0 && now() >= sliceEnd) return false;
            if (this.step()) break;
        }
        this.finish();
        return true;
    }

    /** One node; true when the search must stop. */
    private step(): boolean {
        const graph = this.graph;
        const boundaryHead = this.boundary.peekFirst();
        const pendingHead = this.pending.peek();
        let node: number;
        // On a cost tie the pending heap wins: a queued transport strictly cheaper than walking must
        // claim its destination before an equal-cost boundary node can emit a walking edge to it.
        if (pendingHead !== NO_NODE && (boundaryHead === NO_NODE || graph.compareCost(pendingHead) <= graph.nodeCost(boundaryHead))) {
            node = this.pending.poll();
            // Transports claim their tile when dequeued: the cheapest wins, duplicates drop here.
            const packed = graph.packed(node);
            if (this.visited.get(packed)) return false;
            this.visited.set(packed);
        } else {
            node = this.boundary.pollFirst();
        }
        if (node === NO_NODE) return false;

        const nodeIsTile = graph.isTile(node);
        const nodePacked = nodeIsTile ? graph.packed(node) : UNDEFINED;
        if (nodeIsTile) {
            this.updateWildernessLevel(nodePacked);
            if (this.goals.goals.has(nodePacked)) {
                this.bestLastNode = node;
                this.reachedTarget = nodePacked;
                if (this.shortestAcceptedNode !== NO_NODE) {
                    this.bestLastNode = this.shortestAcceptedNode;
                    this.reachedTarget = this.shortestAcceptedTarget;
                }
                this.terminationReason = "TARGET_REACHED";
                return true;
            }
            if (this.updateBestPathWhenUnreachable(node, nodePacked)) this.lastProgress = now();
            this.updateCustomPathWhenUnreachable(node, nodePacked);
        }

        // The cutoff counts time without progress towards the target.
        if (now() - this.lastProgress > this.config.calculationCutoffMillis) {
            this.terminationReason = "CUTOFF_REACHED";
            return true;
        }

        this.addNeighbors(node, nodeIsTile, nodePacked);
        return false;
    }

    private addNeighbors(node: number, nodeIsTile: boolean, nodePacked: number): void {
        const graph = this.graph;
        const neighbors = this.map.getNeighbors(node, this.visited, this.config, this.wildernessLevel, this.targetInWilderness, graph);
        for (const neighbor of neighbors) {
            const neighborIsTile = graph.isTile(neighbor);
            if (nodeIsTile && neighborIsTile && avoidWilderness(this.config, nodePacked, graph.packed(neighbor), this.targetInWilderness)) {
                continue;
            }
            if (graph.isTransport(neighbor)) {
                // Queued by cost; marked visited when dequeued, so a pricier queued transport can't
                // shadow a cheaper route found later.
                this.pending.add(neighbor);
                this.transportsChecked++;
            } else {
                this.visited.setNode(neighbor, graph);
                this.boundary.addLast(neighbor);
                this.nodesChecked++;
            }
        }
    }

    /**
     * Towards an unreachable target, favour the closest reachable tile: the least squared Euclidean
     * distance, then the least travelled, then the least x, then the least y.
     */
    private updateBestPathWhenUnreachable(node: number, packed: number): boolean {
        let update = false;
        const travelled = this.graph.nodeCost(node);
        const x = unpackWorldX(packed);
        const y = unpackWorldY(packed);
        for (const target of this.targets) {
            const remaining = distanceBetween(target, packed, EUCLIDEAN_SQUARED_DISTANCE_METRIC);
            if (remaining < this.bestRemainingDistance
                || (remaining === this.bestRemainingDistance && travelled < this.bestTravelledDistance)
                || (remaining === this.bestRemainingDistance && travelled === this.bestTravelledDistance && x < this.bestX)
                || (remaining === this.bestRemainingDistance && travelled === this.bestTravelledDistance && x === this.bestX && y < this.bestY)) {
                this.bestRemainingDistance = remaining;
                this.bestTravelledDistance = travelled;
                this.bestX = x;
                this.bestY = y;
                this.bestLastNode = node;
                update = true;
            }
        }
        return update;
    }

    private updateCustomPathWhenUnreachable(node: number, packed: number): void {
        if (this.targets.size <= 1 || this.shortestAcceptedNode !== NO_NODE) return;
        for (const target of this.targets) {
            if (distanceBetween(target, packed, MANHATTAN_DISTANCE_METRIC) <= this.config.unreachableTargetDistance) {
                this.shortestAcceptedNode = node;
                this.shortestAcceptedTarget = target;
                return;
            }
        }
    }

    private updateWildernessLevel(packed: number): void {
        if (this.wildernessLevel <= 0) return;
        // Overlapping boundaries: outside level 30 means 0-29, outside level 20 means 0-19.
        if (this.wildernessLevel > 30 && !isInLevel30Wilderness(packed)) this.wildernessLevel = 30;
        if (this.wildernessLevel > 20 && !isInLevel20Wilderness(packed)) this.wildernessLevel = 20;
        if (this.wildernessLevel > 0 && !isInWilderness(packed)) this.wildernessLevel = 0;
    }

    /** The best path so far (the closest tile reached), while the search runs. */
    getPath(): PathStep[] {
        if (this.result) return this.result.path;
        return this.bestLastNode === NO_NODE ? [] : this.graph.getPathSteps(this.bestLastNode);
    }

    getResult(): PathfinderResult | null {
        return this.result;
    }

    private finish(): void {
        if (this.cancelled) this.terminationReason = "CANCELLED";
        else if (this.terminationReason === null) this.terminationReason = "SEARCH_EXHAUSTED";
        const last = this.bestLastNode;
        const reached = this.reachedTarget !== UNDEFINED;
        this.result = {
            start: this.start,
            reached,
            target: reached ? this.reachedTarget : (this.targets.values().next().value ?? UNDEFINED),
            path: last !== NO_NODE ? this.graph.getPathSteps(last) : [],
            cost: last !== NO_NODE ? this.graph.nodeCost(last) : -1,
            nodesChecked: this.nodesChecked,
            transportsChecked: this.transportsChecked,
            elapsedMillis: now() - this.startTime,
            terminationReason: this.terminationReason!,
        };
        this.finished = true;
        this.boundary.clear();
        this.pending.clear();
    }
}
