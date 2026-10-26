const REGION_SIZE = 64;
const FLAG_COUNT = 4;
const BITS_PER_PLANE = REGION_SIZE * REGION_SIZE * FLAG_COUNT;
const BYTES_PER_PLANE = BITS_PER_PLANE / 8;
const REGION_MASK = REGION_SIZE - 1;

// Per-tile flag layout of the collision map dump: flags 0/1 record whether the north/south and
// east/west edges are open for movement; flags 2/3 mark those edges as structural boundaries
// written by walls and doors rather than object footprints or tile-level blocks.
export const FLAG_NORTH = 0;
export const FLAG_EAST = 1;
export const FLAG_WALL_NORTH = 2;
export const FLAG_WALL_EAST = 3;

export class RegionExtent {
    constructor(readonly minX: number, readonly minY: number, readonly maxX: number, readonly maxY: number) {}
    get width(): number { return this.maxX - this.minX; }
    get height(): number { return this.maxY - this.minY; }
}

export function packRegionPosition(x: number, y: number): number {
    return (x & 0xffff) | ((y & 0xffff) << 16);
}

/**
 * Shortest Path's SplitFlagMap: every region's collision bits, as java.util.BitSet bytes, looked up
 * by tile. Built from the collision map zip's entries ("<regionX>_<regionY>" -> BitSet bytes).
 */
export class SplitFlagMap {
    readonly regionExtents: RegionExtent;
    private readonly regionMapPlaneCounts: Uint8Array;
    private readonly regions: (Uint8Array | undefined)[];
    private readonly widthInclusive: number;

    constructor(compressedRegions: Map<number, Uint8Array>) {
        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
        for (const pos of compressedRegions.keys()) {
            const x = pos & 0xffff, y = (pos >>> 16) & 0xffff;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        if (!Number.isFinite(minX)) minX = minY = 0;
        this.regionExtents = new RegionExtent(minX, minY, maxX, maxY);
        this.widthInclusive = this.regionExtents.width + 1;
        const regionCount = this.widthInclusive * (this.regionExtents.height + 1);
        this.regionMapPlaneCounts = new Uint8Array(regionCount);
        this.regions = new Array(regionCount);
        for (const [pos, bytes] of compressedRegions) {
            const index = this.getIndex(pos & 0xffff, (pos >>> 16) & 0xffff);
            let length = bytes.length;
            while (length > 0 && bytes[length - 1] === 0) length--;
            // BitSet.valueOf trims trailing zero bytes; size() is the long words that leaves.
            const sizeBits = Math.ceil(length / 8) * 64;
            const planeCount = Math.ceil(sizeBits / BITS_PER_PLANE);
            const data = new Uint8Array(planeCount * BYTES_PER_PLANE);
            data.set(bytes.subarray(0, Math.min(length, data.length)));
            this.regionMapPlaneCounts[index] = planeCount;
            this.regions[index] = data;
        }
    }

    getRegionPlaneCounts(index: number): number {
        return this.regionMapPlaneCounts[index] ?? 0;
    }

    getRegionIndex(regionX: number, regionY: number): number {
        return this.getIndex(regionX, regionY);
    }

    get(x: number, y: number, z: number, flag: number): boolean {
        const index = this.getIndex(Math.floor(x / REGION_SIZE), Math.floor(y / REGION_SIZE));
        if (index < 0 || index >= this.regions.length) return false;
        const data = this.regions[index];
        if (!data || z < 0 || z >= this.regionMapPlaneCounts[index]) return false;
        const localBit = (z * REGION_SIZE * REGION_SIZE + (y & REGION_MASK) * REGION_SIZE + (x & REGION_MASK)) * FLAG_COUNT + flag;
        return ((data[localBit >> 3] >> (localBit & 7)) & 1) !== 0;
    }

    private getIndex(regionX: number, regionY: number): number {
        const rx = regionX - this.regionExtents.minX;
        const ry = regionY - this.regionExtents.minY;
        if (rx < 0 || ry < 0 || rx >= this.widthInclusive) return -1;
        return rx + ry * this.widthInclusive;
    }
}
