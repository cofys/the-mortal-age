/**
 * OSRS interaction modes (set_interaction_mode / reset_interaction_mode): what the client does
 * with clicks on the tiles and entities of a world. A mode is set for one world entity (a boat),
 * for the root world, or as the default every world without its own mode falls back to.
 */

/** The world id that changes the default for every world. */
export const INTERACTION_WORLD_DEFAULT = -2;
/** The root (main) world. */
export const INTERACTION_WORLD_ROOT = -1;

export enum TileInteractionMode {
    Disabled = 0,
    /** Tile clicks walk. */
    Walk = 1,
    /** Tile clicks steer the boat the player is at the helm of (set_heading). */
    Heading = 2,
}

export enum EntityInteractionMode {
    Disabled = 0,
    All = 1,
    ExamineOnly = 2,
    /** Sent on logout by revisions 229-232; live sends All since. */
    Default = 3,
}
