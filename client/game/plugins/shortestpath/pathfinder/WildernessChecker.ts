import { distanceToArea2D, type WorldArea } from "../WorldPointUtil";

const area = (x: number, y: number, width: number, height: number): WorldArea => ({ x, y, width, height, plane: 0 });

const WILDERNESS_ABOVE_GROUND = area(2944, 3525, 448, 448);
const WILDERNESS_UNDERGROUND = area(2944, 9918, 518, 458);
const NOT_WILDERNESS = [
    area(3123, 3622, 2, 10), // Ferox Enclave
    area(3125, 3617, 16, 23),
    area(3138, 3636, 18, 10),
    area(3141, 3625, 14, 11),
    area(3141, 3619, 7, 6),
    area(2997, 3525, 34, 9),
    area(3005, 3534, 21, 10),
    area(3000, 3534, 5, 5),
    area(3031, 3525, 2, 2),
];
const WILDERNESS_ABOVE_GROUND_LEVEL_20 = area(2944, 3680, 448, 448);
const WILDERNESS_ABOVE_GROUND_LEVEL_30 = area(2944, 3760, 448, 448);
const WILDERNESS_UNDERGROUND_LEVEL_20 = area(2944, 10075, 518, 301);
const WILDERNESS_UNDERGROUND_LEVEL_30 = area(2944, 10155, 518, 221);

/** Shortest Path's WildernessChecker. */
export function isInWilderness(packed: number): boolean {
    return (distanceToArea2D(packed, WILDERNESS_ABOVE_GROUND) === 0
        && NOT_WILDERNESS.every((a) => distanceToArea2D(packed, a) !== 0))
        || distanceToArea2D(packed, WILDERNESS_UNDERGROUND) === 0;
}

export function anyInWilderness(points: Iterable<number>): boolean {
    for (const point of points) if (isInWilderness(point)) return true;
    return false;
}

export function isInLevel20Wilderness(packed: number): boolean {
    return distanceToArea2D(packed, WILDERNESS_ABOVE_GROUND_LEVEL_20) === 0
        || distanceToArea2D(packed, WILDERNESS_UNDERGROUND_LEVEL_20) === 0;
}

export function isInLevel30Wilderness(packed: number): boolean {
    return distanceToArea2D(packed, WILDERNESS_ABOVE_GROUND_LEVEL_30) === 0
        || distanceToArea2D(packed, WILDERNESS_UNDERGROUND_LEVEL_30) === 0;
}
