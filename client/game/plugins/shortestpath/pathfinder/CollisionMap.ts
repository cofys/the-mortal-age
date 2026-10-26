import { packWorldPoint, unpackWorldPlane, unpackWorldX, unpackWorldY } from "../WorldPointUtil";
import { abstractKindFromWildernessLevel, maxWildernessLevelOf, type NodeGraph } from "./NodeGraph";
import { EMPTY_TRANSPORTS, isUsableAtWildernessLevel, type PathfinderConfig } from "./PathfinderConfig";
import { FLAG_EAST, FLAG_NORTH, FLAG_WALL_EAST, FLAG_WALL_NORTH, type SplitFlagMap } from "./SplitFlagMap";
import type { VisitedTiles } from "./VisitedTiles";
import { isInWilderness } from "./WildernessChecker";

/** OrdinalDirection, in its declaration order. */
const ORDINAL: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Shortest Path's CollisionMap: edge lookups on the split flag map, and a node's neighbours. */
export class CollisionMap {
    // Reused by every getNeighbors call: the search is single threaded.
    private readonly neighbors: number[] = [];
    private readonly traversable = new Array<boolean>(8).fill(false);

    constructor(readonly flags: SplitFlagMap) {}

    n(x: number, y: number, z: number): boolean { return this.flags.get(x, y, z, FLAG_NORTH); }
    s(x: number, y: number, z: number): boolean { return this.n(x, y - 1, z); }
    e(x: number, y: number, z: number): boolean { return this.flags.get(x, y, z, FLAG_EAST); }
    w(x: number, y: number, z: number): boolean { return this.e(x - 1, y, z); }

    // Whether a wall or door sits on the edge, passable or not.
    wallN(x: number, y: number, z: number): boolean { return this.flags.get(x, y, z, FLAG_WALL_NORTH); }
    wallS(x: number, y: number, z: number): boolean { return this.wallN(x, y - 1, z); }
    wallE(x: number, y: number, z: number): boolean { return this.flags.get(x, y, z, FLAG_WALL_EAST); }
    wallW(x: number, y: number, z: number): boolean { return this.wallE(x - 1, y, z); }

    private ne(x: number, y: number, z: number): boolean { return this.n(x, y, z) && this.e(x, y + 1, z) && this.e(x, y, z) && this.n(x + 1, y, z); }
    private nw(x: number, y: number, z: number): boolean { return this.n(x, y, z) && this.w(x, y + 1, z) && this.w(x, y, z) && this.n(x - 1, y, z); }
    private se(x: number, y: number, z: number): boolean { return this.s(x, y, z) && this.e(x, y - 1, z) && this.e(x, y, z) && this.s(x + 1, y, z); }
    private sw(x: number, y: number, z: number): boolean { return this.s(x, y, z) && this.w(x, y - 1, z) && this.w(x, y, z) && this.s(x - 1, y, z); }

    isBlocked(x: number, y: number, z: number): boolean {
        return !this.n(x, y, z) && !this.s(x, y, z) && !this.e(x, y, z) && !this.w(x, y, z);
    }

    private isWalkable(x: number, y: number, z: number): boolean {
        return this.n(x, y, z) || this.s(x, y, z) || this.e(x, y, z) || this.w(x, y, z);
    }

    /** The authoritative walking neighbours, without transport edges. */
    ordinaryWalkingNeighbors(packed: number): number[] {
        const x = unpackWorldX(packed), y = unpackWorldY(packed), z = unpackWorldPlane(packed);
        const result: number[] = [];
        if (!this.isBlocked(x, y, z)) {
            const moves: [boolean, number, number][] = [
                [this.n(x, y, z), 0, 1], [this.ne(x, y, z), 1, 1], [this.e(x, y, z), 1, 0], [this.se(x, y, z), 1, -1],
                [this.s(x, y, z), 0, -1], [this.sw(x, y, z), -1, -1], [this.w(x, y, z), -1, 0], [this.nw(x, y, z), -1, 1],
            ];
            for (const [open, dx, dy] of moves) if (open) result.push(packWorldPoint(x + dx, y + dy, z));
            return result;
        }
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if ((dx === 0 && dy === 0) || !this.isWalkable(x + dx, y + dy, z)) continue;
                if (dx === 0 || dy === 0 || (this.isWalkable(x + dx, y, z) && this.isWalkable(x, y + dy, z))) {
                    result.push(packWorldPoint(x + dx, y + dy, z));
                }
            }
        }
        return result;
    }

    getNeighbors(node: number, visited: VisitedTiles, config: PathfinderConfig, wildernessLevel: number,
        targetInWilderness: boolean, graph: NodeGraph): number[] {
        return graph.isTile(node)
            ? this.getTileNeighbors(node, visited, config, wildernessLevel, graph)
            : this.getAbstractNodeNeighbors(node, visited, config, targetInWilderness, graph);
    }

    // A walkable tile's neighbours: transports from it, the global-teleport node (once per
    // wilderness bucket), and the tiles it can walk to.
    private getTileNeighbors(node: number, visited: VisitedTiles, config: PathfinderConfig, wildernessLevel: number,
        graph: NodeGraph): number[] {
        const packed = graph.packed(node);
        const x = unpackWorldX(packed), y = unpackWorldY(packed), z = unpackWorldPlane(packed);
        const neighbors = this.neighbors;
        neighbors.length = 0;

        // A tile reached by a delayed-visit teleport passes its differential cost on to the
        // delayed-visit transports leaving it, so a whistle-then-fly chain never beats a direct teleport.
        const inherited = graph.isTransport(node) && graph.isDelayedVisit(node) ? graph.differentialCost(node) : 0;
        for (const transport of config.transports.get(packed) ?? EMPTY_TRANSPORTS) {
            if (!transport.delayedVisit && visited.get(transport.destination)) continue;
            const chainPenalty = transport.delayedVisit && inherited > 0 ? inherited : 0;
            neighbors.push(graph.createTransport(transport.destination, node, transport.duration,
                transport.additionalCost + chainPenalty, transport.delayedVisit,
                transport.delayedVisit ? transport.differentialCost : 0, transport));
        }

        const kind = abstractKindFromWildernessLevel(wildernessLevel);
        if (!visited.getAbstract(kind)) neighbors.push(graph.createAbstract(kind, node));

        const t = this.traversable;
        if (this.isBlocked(x, y, z)) {
            const westBlocked = this.isBlocked(x - 1, y, z);
            const eastBlocked = this.isBlocked(x + 1, y, z);
            const southBlocked = this.isBlocked(x, y - 1, z);
            const northBlocked = this.isBlocked(x, y + 1, z);
            t[0] = !westBlocked;
            t[1] = !eastBlocked;
            t[2] = !southBlocked;
            t[3] = !northBlocked;
            t[4] = !this.isBlocked(x - 1, y - 1, z) && !westBlocked && !southBlocked;
            t[5] = !this.isBlocked(x + 1, y - 1, z) && !eastBlocked && !southBlocked;
            t[6] = !this.isBlocked(x - 1, y + 1, z) && !westBlocked && !northBlocked;
            t[7] = !this.isBlocked(x + 1, y + 1, z) && !eastBlocked && !northBlocked;
        } else {
            t[0] = this.w(x, y, z);
            t[1] = this.e(x, y, z);
            t[2] = this.s(x, y, z);
            t[3] = this.n(x, y, z);
            t[4] = this.sw(x, y, z);
            t[5] = this.se(x, y, z);
            t[6] = this.nw(x, y, z);
            t[7] = this.ne(x, y, z);
        }

        for (let i = 0; i < 8; i++) {
            const [dx, dy] = ORDINAL[i];
            const neighbor = packWorldPoint(x + dx, y + dy, z);
            if (visited.get(neighbor)) continue;
            if (t[i]) {
                neighbors.push(graph.createTile(neighbor, node));
            } else if (Math.abs(dx + dy) === 1 && this.isBlocked(x + dx, y + dy, z)) {
                // A transport starting on a blocked adjacent tile, e.g. a fairy ring: walk onto it.
                for (const transport of config.transports.get(neighbor) ?? EMPTY_TRANSPORTS) {
                    if (!isUsableAtWildernessLevel(transport, wildernessLevel) || visited.get(transport.origin)) continue;
                    neighbors.push(graph.createTile(transport.origin, node));
                }
            }
        }
        return neighbors;
    }

    // The only abstract nodes are for global teleports.
    private getAbstractNodeNeighbors(node: number, visited: VisitedTiles, config: PathfinderConfig,
        targetInWilderness: boolean, graph: NodeGraph): number[] {
        const neighbors = this.neighbors;
        neighbors.length = 0;
        const sourceTile = graph.getClosestTilePosition(node);
        const maxWildernessLevel = maxWildernessLevelOf(graph.abstractKind(node));
        for (const transport of config.teleports) {
            if (!transport.delayedVisit && visited.get(transport.destination)) continue;
            if (!isUsableAtWildernessLevel(transport, maxWildernessLevel)) continue;
            if (avoidWilderness(config, sourceTile, transport.destination, targetInWilderness)) continue;
            neighbors.push(graph.createTransport(transport.destination, node, transport.duration, transport.additionalCost,
                transport.delayedVisit, transport.delayedVisit ? transport.differentialCost : 0, transport));
        }
        return neighbors;
    }
}

/** PathfinderConfig.avoidWilderness: don't step into the wilderness unless the target is in it. */
export function avoidWilderness(config: PathfinderConfig, packed: number, neighbor: number, targetInWilderness: boolean): boolean {
    return config.avoidWilderness && !targetInWilderness && !isInWilderness(packed) && isInWilderness(neighbor);
}
