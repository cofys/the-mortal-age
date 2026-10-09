// Local map coordinates in tiles, retained by structured-clone worker messages.
export type DrawRange = [number, number, number] & {
    batchKey?: number; // identical terrain instance data, for contiguous batching
    bounds?: number[]; // min XYZ, max XYZ
    chunk?: [number, number]; // 8-tile chunk origin
};

export function newDrawRange(offset: number, elements: number, instances: number = 1): DrawRange {
    return [offset, elements, instances];
}

export const NULL_DRAW_RANGE = newDrawRange(0, 0, 0);
