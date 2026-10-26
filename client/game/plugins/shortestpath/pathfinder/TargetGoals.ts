import { packWorldPoint, unpackWorldPlane, unpackWorldX, unpackWorldY } from "../WorldPointUtil";
import type { CollisionMap } from "./CollisionMap";
import type { PathfinderConfig } from "./PathfinderConfig";

// How many walking steps the enclosure check around a blocked target takes. Within a couple of
// steps a wall still separates its two sides; further out both connect around wall ends.
const ENCLOSURE_DEPTH = 3;
// How far out from a blocked target to score walkable candidates.
const ENCLOSURE_SCAN_RADIUS = 4;
// The blocked-target scan stays cheap however large unreachableTargetDistance is.
const MAX_GOAL_EXPANSION_RADIUS = 64;

/**
 * Shortest Path's TargetGoals: the tiles a search ends on. A walkable target ends on itself; a
 * blocked one expands to the nearest fallback tiles within unreachableTargetDistance — every
 * walkable tile of the innermost ring, or with collisionAwareBlockedTargets only those on the
 * target's own side of its walls.
 */
export class TargetGoals {
    private constructor(
        readonly goals: ReadonlySet<number>,
        private readonly viable: boolean,
        private readonly fallbackTiles: ReadonlyMap<number, ReadonlySet<number>>,
    ) {}

    hasViableGoal(): boolean { return this.viable; }

    fallbacks(target: number): ReadonlySet<number> {
        return this.fallbackTiles.get(target) ?? new Set();
    }

    static resolve(config: PathfinderConfig, start: number, targets: ReadonlySet<number>): TargetGoals {
        const map = config.map;
        const goals = new Set(targets);
        const fallbacks = new Map<number, Set<number>>();
        let viable = false;
        for (const target of targets) {
            const x = unpackWorldX(target), y = unpackWorldY(target), z = unpackWorldPlane(target);
            if (!map.isBlocked(x, y, z)) {
                viable = true;
                continue;
            }
            // A transport landing on a blocked target still reaches it (a fairy ring, say).
            if (config.transportDestinations.has(target)) viable = true;
            const radius = Math.min(config.unreachableTargetDistance, MAX_GOAL_EXPANSION_RADIUS);
            const targetGoals = config.collisionAwareBlockedTargets
                ? expandingConnectedGoals(config, map, start, target, radius)
                : expandingRingGoals(config, map, start, x, y, z, radius);
            if (targetGoals.size > 0) {
                for (const goal of targetGoals) goals.add(goal);
                fallbacks.set(target, targetGoals);
                viable = true;
            }
        }
        return new TargetGoals(goals, viable, fallbacks);
    }
}

// The tiles on Chebyshev ring r as flat (dx, dy) pairs, in perimeter order.
function ringOffsets(r: number): number[] {
    const offsets: number[] = [];
    for (let s = -r; s < r; s++) offsets.push(s, -r, r, s, -s, r, -r, -s);
    return offsets;
}

function expandingRingGoals(config: PathfinderConfig, map: CollisionMap, start: number, x: number, y: number, z: number,
    radius: number): Set<number> {
    const goals = new Set<number>();
    for (let r = 1; r <= radius && goals.size === 0; r++) {
        const ring = ringOffsets(r);
        // A diagonal tile on the interaction ring only counts when no cardinal tile is usable.
        const diagonals = new Set<number>();
        for (let i = 0; i < ring.length; i += 2) {
            const nx = x + ring[i], ny = y + ring[i + 1];
            const packed = packWorldPoint(nx, ny, z);
            if (r === 1 && nx !== x && ny !== y && packed !== start && !map.isBlocked(nx, ny, z)) {
                diagonals.add(packed);
                continue;
            }
            if (packed !== start && (!map.isBlocked(nx, ny, z) || config.transportDestinations.has(packed))) goals.add(packed);
        }
        if (r === 1 && goals.size === 0) for (const d of diagonals) goals.add(d);
    }
    return goals;
}

function wallBetween(map: CollisionMap, ax: number, ay: number, bx: number, by: number, z: number): boolean {
    return bx !== ax ? map.wallE(Math.min(ax, bx), ay, z) : map.wallN(ax, Math.min(ay, by), z);
}

function wallSeparated(map: CollisionMap, x: number, y: number, nx: number, ny: number, z: number): boolean {
    const dx = nx - x, dy = ny - y;
    if (dx === 0 || dy === 0) return wallBetween(map, x, y, nx, ny, z);
    return (wallBetween(map, x, y, x + dx, y, z) || wallBetween(map, x + dx, y, nx, ny, z))
        && (wallBetween(map, x, y, x, y + dy, z) || wallBetween(map, x, y + dy, nx, ny, z));
}

// How many tiles are reachable within ENCLOSURE_DEPTH steps: rooms score lower than open ground.
function localReach(map: CollisionMap, packed: number): number {
    const seen = new Set([packed]);
    let frontier = [packed];
    for (let depth = 0; depth < ENCLOSURE_DEPTH; depth++) {
        const next: number[] = [];
        for (const tile of frontier) {
            for (const neighbour of map.ordinaryWalkingNeighbors(tile)) {
                if (!seen.has(neighbour)) {
                    seen.add(neighbour);
                    next.push(neighbour);
                }
            }
        }
        frontier = next;
    }
    return seen.size;
}

const isCardinalFace = (packed: number, x: number, y: number) => unpackWorldX(packed) === x || unpackWorldY(packed) === y;

// The most enclosed candidate of the innermost ring anchors the target's side; flooding from it
// without crossing a wall finds the tiles on that side. Transport destinations ignore walls.
function expandingConnectedGoals(config: PathfinderConfig, map: CollisionMap, start: number, target: number,
    radius: number): Set<number> {
    const x = unpackWorldX(target), y = unpackWorldY(target), z = unpackWorldPlane(target);
    const scan = Math.min(radius, ENCLOSURE_SCAN_RADIUS);
    const candidates: number[] = [];
    const boundaryFaces = new Set<number>();
    let anchor = -1;
    let anchorRing = 0;
    let anchorReach = Number.MAX_SAFE_INTEGER;
    for (let d = 1; d <= scan && anchorRing === 0; d++) {
        const ring = ringOffsets(d);
        for (let i = 0; i < ring.length; i += 2) {
            const nx = x + ring[i], ny = y + ring[i + 1];
            const packed = packWorldPoint(nx, ny, z);
            if (packed === start || map.isBlocked(nx, ny, z)) continue;
            if (d === 1 && wallSeparated(map, x, y, nx, ny, z)) {
                boundaryFaces.add(packed);
                continue;
            }
            const reach = localReach(map, packed);
            candidates.push(packed);
            if (reach < anchorReach) {
                anchorReach = reach;
                anchor = packed;
            }
        }
        if (candidates.length > 0) anchorRing = d;
    }

    const sameSide = new Set<number>();
    if (anchor !== -1) {
        const queue = [anchor];
        sameSide.add(anchor);
        while (queue.length > 0) {
            const from = queue.shift()!;
            const fx = unpackWorldX(from), fy = unpackWorldY(from);
            for (const step of map.ordinaryWalkingNeighbors(from)) {
                const sx = unpackWorldX(step), sy = unpackWorldY(step);
                if (Math.max(Math.abs(sx - x), Math.abs(sy - y)) <= anchorRing && !wallSeparated(map, fx, fy, sx, sy, z) && !sameSide.has(step)) {
                    sameSide.add(step);
                    queue.push(step);
                }
            }
        }
    }

    const goals = new Set<number>();
    const diagonals = new Set<number>();
    for (let d = 1; d <= radius && goals.size === 0; d++) {
        if (d === 1) {
            for (const face of boundaryFaces) {
                if (sameSide.has(face)) (isCardinalFace(face, x, y) ? goals : diagonals).add(face);
            }
            if (anchorRing === 1) {
                for (const candidate of candidates) {
                    if (sameSide.has(candidate)) (isCardinalFace(candidate, x, y) ? goals : diagonals).add(candidate);
                }
            }
            if (goals.size === 0) for (const d2 of diagonals) goals.add(d2);
        } else if (d === anchorRing) {
            for (const candidate of candidates) if (sameSide.has(candidate)) goals.add(candidate);
        }
        const ring = ringOffsets(d);
        for (let i = 0; i < ring.length; i += 2) {
            const packed = packWorldPoint(x + ring[i], y + ring[i + 1], z);
            if (packed !== start && config.transportDestinations.has(packed)) goals.add(packed);
        }
    }
    return goals;
}
