import type { CollisionMap } from "./CollisionMap";

/**
 * A usable transport as the search sees it: its ends, its cost, and the index of the Transport it
 * came from (PathfinderConfig keeps the full rows; the worker only needs these numbers).
 */
export type PathTransport = {
    readonly index: number;
    readonly origin: number;
    readonly destination: number;
    readonly duration: number;
    /** PathfinderConfig.getAdditionalTransportCost: the type's (or consumable) tiles-saved threshold. */
    readonly additionalCost: number;
    /** A type sharing destinations with another (quetzals and the whistle) competes in the queue. */
    readonly delayedVisit: boolean;
    /** PathfinderConfig.getDifferentialCost: queue-ordering only, for delayed visits. */
    readonly differentialCost: number;
    readonly isTeleport: boolean;
    readonly maxWildernessLevel: number;
};

/** The parts of Shortest Path's PathfinderConfig a search reads, captured at refresh. */
export type PathfinderConfig = {
    readonly map: CollisionMap;
    /** Usable transports with an origin tile, by origin. */
    readonly transports: ReadonlyMap<number, readonly PathTransport[]>;
    /** Usable teleports, which have no origin tile. */
    readonly teleports: readonly PathTransport[];
    /** Every loaded transport's destination, usable or not (isTransportDestination). */
    readonly transportDestinations: ReadonlySet<number>;
    readonly avoidWilderness: boolean;
    readonly unreachableTargetDistance: number;
    readonly collisionAwareBlockedTargets: boolean;
    readonly calculationCutoffMillis: number;
};

export const EMPTY_TRANSPORTS: readonly PathTransport[] = [];

/** Transport.isUsableAtWildernessLevel: a teleport only works up to its wilderness level. */
export function isUsableAtWildernessLevel(transport: PathTransport, wildernessLevel: number): boolean {
    return !transport.isTeleport || wildernessLevel <= transport.maxWildernessLevel;
}
