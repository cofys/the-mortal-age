import { unpackWorldPlane, unpackWorldX, unpackWorldY } from "../WorldPointUtil";
import { ABSTRACT_NODE_KINDS, type AbstractNodeKind, type NodeGraph } from "./NodeGraph";
import type { SplitFlagMap } from "./SplitFlagMap";

const REGION_SIZE = 64;

/** One region's visited tiles: a 64-bit row per (plane, y), as two 32-bit halves. */
class VisitedRegion {
    private readonly rows: Uint32Array;

    constructor(private readonly planeCount: number) {
        this.rows = new Uint32Array(planeCount * REGION_SIZE * 2);
    }

    /** Marks a tile; true when it had not been seen. A plane the region lacks counts as seen. */
    set(x: number, y: number, plane: number): boolean {
        if (plane >= this.planeCount) return false;
        const index = (y + plane * REGION_SIZE) * 2 + (x >> 5);
        const bit = 1 << (x & 31);
        const unique = (this.rows[index] & bit) === 0;
        this.rows[index] |= bit;
        return unique;
    }

    get(x: number, y: number, plane: number): boolean {
        if (plane >= this.planeCount) return true;
        return (this.rows[(y + plane * REGION_SIZE) * 2 + (x >> 5)] & (1 << (x & 31))) !== 0;
    }
}

/** Shortest Path's VisitedTiles, without the bank layer. Tiles outside the map count as visited. */
export class VisitedTiles {
    private readonly widthInclusive: number;
    private readonly regions: (VisitedRegion | undefined)[];
    private readonly abstractVisited = new Array<boolean>(ABSTRACT_NODE_KINDS).fill(false);

    constructor(private readonly flags: SplitFlagMap) {
        const extent = flags.regionExtents;
        this.widthInclusive = extent.width + 1;
        this.regions = new Array(this.widthInclusive * (extent.height + 1));
    }

    private regionIndex(x: number, y: number): number {
        const extent = this.flags.regionExtents;
        const rx = Math.floor(x / REGION_SIZE) - extent.minX;
        const ry = Math.floor(y / REGION_SIZE) - extent.minY;
        if (rx < 0 || ry < 0 || rx >= this.widthInclusive) return -1;
        return rx + ry * this.widthInclusive;
    }

    get(packed: number): boolean {
        const x = unpackWorldX(packed), y = unpackWorldY(packed);
        const index = this.regionIndex(x, y);
        if (index < 0 || index >= this.regions.length) return true;
        const region = this.regions[index];
        return region ? region.get(x % REGION_SIZE, y % REGION_SIZE, unpackWorldPlane(packed)) : false;
    }

    set(packed: number): boolean {
        const x = unpackWorldX(packed), y = unpackWorldY(packed);
        const index = this.regionIndex(x, y);
        if (index < 0 || index >= this.regions.length) return false;
        let region = this.regions[index];
        if (!region) this.regions[index] = region = new VisitedRegion(this.flags.getRegionPlaneCounts(index));
        return region.set(x % REGION_SIZE, y % REGION_SIZE, unpackWorldPlane(packed));
    }

    getNode(id: number, graph: NodeGraph): boolean {
        return graph.isTile(id) ? this.get(graph.packed(id)) : this.abstractVisited[graph.abstractKind(id)];
    }

    setNode(id: number, graph: NodeGraph): boolean {
        if (graph.isTile(id)) return this.set(graph.packed(id));
        const kind = graph.abstractKind(id);
        const visited = this.abstractVisited[kind];
        this.abstractVisited[kind] = true;
        return !visited;
    }

    getAbstract(kind: AbstractNodeKind): boolean {
        return this.abstractVisited[kind];
    }
}
