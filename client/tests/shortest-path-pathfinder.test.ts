import { strict as assert } from "node:assert";
import { CollisionMap } from "../game/plugins/shortestpath/pathfinder/CollisionMap";
import { Pathfinder } from "../game/plugins/shortestpath/pathfinder/Pathfinder";
import type { PathfinderConfig, PathTransport } from "../game/plugins/shortestpath/pathfinder/PathfinderConfig";
import { FLAG_EAST, FLAG_NORTH, FLAG_WALL_EAST, packRegionPosition, SplitFlagMap } from "../game/plugins/shortestpath/pathfinder/SplitFlagMap";
import { packWorldPoint as p, unpackWorldPlane, unpackWorldX, unpackWorldY } from "../game/plugins/shortestpath/WorldPointUtil";

// --- A synthetic map: region (50, 50), tiles 3200-3263 x 3200-3263, plane 0 open, plane 1 a room --
const BASE = 3200;
class MapBuilder {
    readonly bits = new Uint8Array(2 * 64 * 64 * 4 / 8);
    private set(x: number, y: number, z: number, flag: number, value: boolean) {
        if (x < BASE || y < BASE || x >= BASE + 64 || y >= BASE + 64) return;
        const bit = ((z * 64 + (y - BASE)) * 64 + (x - BASE)) * 4 + flag;
        if (value) this.bits[bit >> 3] |= 1 << (bit & 7);
        else this.bits[bit >> 3] &= ~(1 << (bit & 7));
    }
    open(x0: number, y0: number, x1: number, y1: number, z: number) {
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            if (y < y1) this.set(x, y, z, FLAG_NORTH, true);
            if (x < x1) this.set(x, y, z, FLAG_EAST, true);
        }
        return this;
    }
    /** A wall on the east edge of each tile in the column, with an optional open door at doorY. */
    eastWall(x: number, y0: number, y1: number, z: number, doorY?: number) {
        for (let y = y0; y <= y1; y++) {
            this.set(x, y, z, FLAG_EAST, y === doorY);
            this.set(x, y, z, FLAG_WALL_EAST, true);
        }
        return this;
    }
    build(): CollisionMap {
        return new CollisionMap(new SplitFlagMap(new Map([[packRegionPosition(50, 50), this.bits]])));
    }
}

function config(map: CollisionMap, transports: PathTransport[] = [], extra: Partial<PathfinderConfig> = {}): PathfinderConfig {
    const byOrigin = new Map<number, PathTransport[]>();
    const teleports: PathTransport[] = [];
    for (const t of transports) {
        if (t.origin === -1) teleports.push(t);
        else byOrigin.set(t.origin, [...(byOrigin.get(t.origin) ?? []), t]);
    }
    return {
        map, transports: byOrigin, teleports, transportDestinations: new Set(transports.map((t) => t.destination)),
        avoidWilderness: true, unreachableTargetDistance: 2, collisionAwareBlockedTargets: true, calculationCutoffMillis: 3000,
        ...extra,
    };
}

function transport(index: number, origin: number, destination: number, duration: number, extra: Partial<PathTransport> = {}): PathTransport {
    return { index, origin, destination, duration, additionalCost: 0, delayedVisit: false, differentialCost: 0, isTeleport: false, maxWildernessLevel: -1, ...extra };
}

const xyz = (packed: number) => `${unpackWorldX(packed)},${unpackWorldY(packed)},${unpackWorldPlane(packed)}`;

// --- Open ground: a straight walk, one tile per step, cost = Chebyshev distance ------------------
{
    const map = new MapBuilder().open(3200, 3200, 3263, 3263, 0).build();
    const result = new Pathfinder(config(map), p(3210, 3210, 0), [p(3220, 3215, 0)]).run();
    assert.equal(result.reached, true);
    assert.equal(result.terminationReason, "TARGET_REACHED");
    assert.equal(result.path.length, 11, "10 steps, diagonals included");
    assert.equal(result.cost, 10);
    assert.equal(xyz(result.path[0].packed), "3210,3210,0");
    assert.equal(xyz(result.path.at(-1)!.packed), "3220,3215,0");
    // Shortest Path prefers straight moves first: west, east, south, north before the diagonals.
    assert.equal(xyz(result.path[1].packed), "3211,3210,0");
}

// --- A wall with a door: the route goes through the door ----------------------------------------
{
    const map = new MapBuilder().open(3200, 3200, 3263, 3263, 0).eastWall(3215, 3200, 3263, 0, 3230).build();
    const result = new Pathfinder(config(map), p(3210, 3210, 0), [p(3220, 3210, 0)]).run();
    assert.equal(result.reached, true);
    const steps = result.path.map((s) => xyz(s.packed));
    assert.ok(steps.includes("3215,3230,0") && steps.includes("3216,3230,0"), "crosses at the door");
    for (let i = 1; i < steps.length; i++) {
        const [ax, ay] = steps[i - 1].split(",").map(Number);
        const [bx] = steps[i].split(",").map(Number);
        if (ax === 3215 && bx === 3216) assert.equal(ay, 3230, "only at the door");
    }

    // With the door shut too, the target is unreachable: the path ends at the closest tile.
    const closed = new MapBuilder().open(3200, 3200, 3263, 3263, 0).eastWall(3215, 3200, 3263, 0).build();
    const blocked = new Pathfinder(config(closed), p(3210, 3210, 0), [p(3220, 3210, 0)]).run();
    assert.equal(blocked.reached, false);
    assert.equal(blocked.terminationReason, "SEARCH_EXHAUSTED");
    assert.equal(xyz(blocked.path.at(-1)!.packed), "3215,3210,0", "the nearest tile west of the wall");
}

// --- A transport changes plane: stairs from plane 0 up to a room on plane 1 ----------------------
{
    const map = new MapBuilder().open(3200, 3200, 3263, 3263, 0).open(3240, 3240, 3245, 3245, 1).build();
    const stairs = transport(7, p(3230, 3230, 0), p(3240, 3240, 1), 1);
    const result = new Pathfinder(config(map, [stairs]), p(3225, 3225, 0), [p(3244, 3244, 1)]).run();
    assert.equal(result.reached, true);
    const climb = result.path.findIndex((s) => s.transport === 7);
    assert.ok(climb > 0, "the stairs are taken");
    assert.equal(xyz(result.path[climb - 1].packed), "3230,3230,0");
    assert.equal(xyz(result.path[climb].packed), "3240,3240,1");
    assert.equal(result.cost, 5 + 1 + 4, "walk 5, climb 1, walk 4");
}

// --- A teleport beats a long walk; its threshold can make walking win instead ---------------------
{
    const map = new MapBuilder().open(3200, 3200, 3263, 3263, 0).build();
    const teleport = transport(3, -1, p(3260, 3260, 0), 5, { isTeleport: true, maxWildernessLevel: 20 });
    const start = p(3201, 3201, 0);
    const target = p(3258, 3258, 0);
    const teleported = new Pathfinder(config(map, [teleport]), start, [target]).run();
    assert.equal(teleported.reached, true);
    assert.ok(teleported.path.some((s) => s.transport === 3), "teleports");
    assert.equal(teleported.cost, 5 + 2);

    const priced = new Pathfinder(config(map, [{ ...teleport, additionalCost: 60 }]), start, [target]).run();
    assert.ok(!priced.path.some((s) => s.transport === 3), "a 60-tile threshold makes the 57-tile walk cheaper");
    assert.equal(priced.cost, 57);
}

// --- A blocked target ends on the tile beside it --------------------------------------------------
{
    const builder = new MapBuilder().open(3200, 3200, 3263, 3263, 0);
    // Close every edge of (3230, 3230), like a table in the middle of a room.
    builder.eastWall(3229, 3230, 3230, 0).eastWall(3230, 3230, 3230, 0);
    (builder as any).set(3230, 3230, 0, FLAG_NORTH, false);
    (builder as any).set(3230, 3229, 0, FLAG_NORTH, false);
    const result = new Pathfinder(config(builder.build()), p(3220, 3230, 0), [p(3230, 3230, 0)]).run();
    assert.equal(result.reached, true, "a fallback tile counts as reaching the target");
    assert.equal(xyz(result.path.at(-1)!.packed), "3229,3230,0");
}

// --- The search runs in slices and can be cancelled between them ---------------------------------
{
    const map = new MapBuilder().open(3200, 3200, 3263, 3263, 0).build();
    const search = new Pathfinder(config(map), p(3200, 3200, 0), [p(3263, 3263, 0)]);
    search.cancel();
    assert.equal(search.runFor(10), true);
    assert.equal(search.getResult()!.terminationReason, "CANCELLED");
}

console.log("shortest-path-pathfinder: ok");
