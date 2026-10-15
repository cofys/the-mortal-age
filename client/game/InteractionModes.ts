/**
 * OSRS interaction modes (set_interaction_mode / reset_interaction_mode): what clicks on the
 * tiles and entities of a world do. The server sets them per world entity (a boat), for the
 * root world (-1), or as the default (-2) that every world without its own mode follows.
 *
 * At a boat's helm live sets the default to heading, so clicks on the sea steer, and the boat's
 * own world to walk; leaving the helm resets the boat's world and the default goes back to walk.
 * The client keeps the modes until told otherwise, which is why live sets walk again just before
 * every logout.
 */

/** The world id that changes the default for every world. */
export const INTERACTION_WORLD_DEFAULT = -2;
/** The root (main) world. */
export const INTERACTION_WORLD_ROOT = -1;

export const enum TileInteractionMode {
    Disabled = 0,
    /** Tile clicks walk (MOVE_GAMECLICK). */
    Walk = 1,
    /** Tile clicks steer the boat the player is at the helm of (SET_HEADING). */
    Heading = 2,
}

export const enum EntityInteractionMode {
    Disabled = 0,
    All = 1,
    ExamineOnly = 2,
    /** Sent on logout by revisions 229-232. */
    Default = 3,
}

export interface InteractionMode {
    tile: number;
    entity: number;
}

const WALK_ALL: InteractionMode = { tile: TileInteractionMode.Walk, entity: EntityInteractionMode.All };

export class InteractionModes {
    private defaultMode: InteractionMode = { ...WALK_ALL };
    private readonly worlds = new Map<number, InteractionMode>();

    set(worldId: number, tile: number, entity: number): void {
        if (worldId === INTERACTION_WORLD_DEFAULT) this.defaultMode = { tile, entity };
        else this.worlds.set(worldId, { tile, entity });
    }

    reset(worldId: number): void {
        if (worldId === INTERACTION_WORLD_DEFAULT) this.defaultMode = { ...WALK_ALL };
        else this.worlds.delete(worldId);
    }

    /** The mode for clicks in a world: a world entity index, or -1 for the root world. */
    get(worldId: number): InteractionMode {
        return this.worlds.get(worldId) ?? this.defaultMode;
    }

    tileMode(worldId: number): number {
        return this.get(worldId).tile;
    }

    clear(): void {
        this.defaultMode = { ...WALK_ALL };
        this.worlds.clear();
    }
}

export const interactionModes = new InteractionModes();
