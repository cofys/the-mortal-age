/**
 * Shortest Path's WorldPointUtil: a world point packed into one int (x and y in 15 bits each,
 * the plane in the top two), and the distance metrics the pathfinder uses.
 */
export const UNDEFINED = -1;
export const CHEBYSHEV_DISTANCE_METRIC = 1;
export const EUCLIDEAN_SQUARED_DISTANCE_METRIC = 1414213562;
export const MANHATTAN_DISTANCE_METRIC = 2;
const INT_MAX = 2147483647;

export function packWorldPoint(x: number, y: number, plane: number): number {
    return (x & 0x7fff) | ((y & 0x7fff) << 15) | ((plane & 0x3) << 30);
}

export function unpackWorldX(packed: number): number {
    return packed & 0x7fff;
}

export function unpackWorldY(packed: number): number {
    return (packed >> 15) & 0x7fff;
}

export function unpackWorldPlane(packed: number): number {
    return (packed >> 30) & 0x3;
}

export function dxdy(packed: number, dx: number, dy: number): number {
    return packWorldPoint(unpackWorldX(packed) + dx, unpackWorldY(packed) + dy, unpackWorldPlane(packed));
}

export function distanceBetween2DXY(previousX: number, previousY: number, currentX: number, currentY: number,
    diagonal: number = CHEBYSHEV_DISTANCE_METRIC): number {
    const dx = previousX - currentX;
    const dy = previousY - currentY;
    if (diagonal === CHEBYSHEV_DISTANCE_METRIC) return Math.max(Math.abs(dx), Math.abs(dy));
    if (diagonal === MANHATTAN_DISTANCE_METRIC) return Math.abs(dx) + Math.abs(dy);
    return dx * dx + dy * dy;
}

/** Distance on one plane; points on different planes are INT_MAX apart. */
export function distanceBetween(previous: number, current: number, diagonal: number = CHEBYSHEV_DISTANCE_METRIC): number {
    if (unpackWorldPlane(previous) !== unpackWorldPlane(current)) return INT_MAX;
    return distanceBetween2D(previous, current, diagonal);
}

export function distanceBetween2D(previous: number, current: number, diagonal: number = CHEBYSHEV_DISTANCE_METRIC): number {
    return distanceBetween2DXY(unpackWorldX(previous), unpackWorldY(previous), unpackWorldX(current), unpackWorldY(current), diagonal);
}

/** RuneLite's WorldArea: x, y, width, height, plane. */
export type WorldArea = { x: number; y: number; width: number; height: number; plane: number };

export function distanceToArea2D(packed: number, area: WorldArea): number {
    const x = unpackWorldX(packed);
    const y = unpackWorldY(packed);
    const maxX = area.x + area.width - 1;
    const maxY = area.y + area.height - 1;
    const dx = Math.max(Math.max(area.x - x, 0), x - maxX);
    const dy = Math.max(Math.max(area.y - y, 0), y - maxY);
    return Math.max(dx, dy);
}
