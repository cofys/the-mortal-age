/** An NPC as the NPC events carry it: its ECS slot, server index and current type id. */
export type NpcRef = {
    /** The client's ECS id for the NPC (stable while it is loaded). */
    readonly ecsId: number;
    /** The server's NPC index (RuneLite's NPC.getIndex()). */
    readonly index: number;
    /** The NPC type id when the event was posted (RuneLite's NPC.getId()). */
    readonly id: number;
};

/** A server NPC came into view (RuneLite's NpcSpawned). */
export class NpcSpawned {
    constructor(private readonly npc: NpcRef) {}

    getNpc(): NpcRef {
        return this.npc;
    }
}

/** A server NPC left view or was removed (RuneLite's NpcDespawned). */
export class NpcDespawned {
    constructor(private readonly npc: NpcRef) {}

    getNpc(): NpcRef {
        return this.npc;
    }
}

/** A server NPC's type changed, e.g. a transform (RuneLite's NpcChanged). */
export class NpcChanged {
    constructor(
        private readonly npc: NpcRef,
        private readonly oldId: number,
    ) {}

    getNpc(): NpcRef {
        return this.npc;
    }

    /** The type id before the change. */
    getOld(): number {
        return this.oldId;
    }
}
