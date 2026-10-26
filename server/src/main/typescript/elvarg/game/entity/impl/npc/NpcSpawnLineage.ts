import { World } from "../../../World";
import type { NPC } from "./NPC";

/**
 * What put an NPC in the world (the spawn file, or a plugin by name). A respawn clone
 * inherits it, so everything one source placed can be found and taken out together, and a
 * retired lineage queues no more respawns.
 */
export class NpcSpawnLineage {
    private retired = false;

    constructor(public readonly owner: string) {}

    public isRetired(): boolean {
        return this.retired;
    }

    /** Stops its queued respawns and takes its NPCs (without a player owner, if asked) out. */
    public retire(options: { keepPlayerOwned?: boolean } = {}): number {
        this.retired = true;
        let removed = 0;
        for (const npc of NpcSpawnLineage.liveNpcs()) {
            if (npc.getSpawnLineage() !== this) continue;
            if (options.keepPlayerOwned && npc.getOwner()) continue;
            NpcSpawnLineage.remove(npc);
            removed++;
        }
        return removed;
    }

    /** Key -> the NPC that holds it: a boss that must never be in the world twice. */
    private static readonly uniqueHolders = new Map<string, NPC>();

    /** In the world or queued to join it, and not queued to leave. */
    public static isLive(npc: NPC): boolean {
        if (World.getRemoveNPCQueue().includes(npc)) return false;
        return npc.isRegistered() || World.getAddNPCQueue().includes(npc);
    }

    /** The live NPC holding `key`, or null once it has left the world. */
    public static uniqueHolder(key: string): NPC | null {
        const holder = NpcSpawnLineage.uniqueHolders.get(key);
        if (!holder) return null;
        if (NpcSpawnLineage.isLive(holder)) return holder;
        NpcSpawnLineage.uniqueHolders.delete(key);
        return null;
    }

    /** Gives `npc` the key unless a live NPC already holds it. */
    public static claimUnique(key: string, npc: NPC): boolean {
        const holder = NpcSpawnLineage.uniqueHolder(key);
        if (holder && holder !== npc) return false;
        npc.setUniqueKey(key);
        NpcSpawnLineage.uniqueHolders.set(key, npc);
        return true;
    }

    private static liveNpcs(): NPC[] {
        const npcs = new Set<NPC>(World.getAddNPCQueue());
        for (const npc of World.getNpcs()) {
            if (npc) npcs.add(npc);
        }
        return [...npcs];
    }

    private static remove(npc: NPC): void {
        for (const queue of [World.getAddNPCQueue(), World.getRemoveNPCQueue()]) {
            for (let index = queue.indexOf(npc); index !== -1; index = queue.indexOf(npc)) {
                queue.splice(index, 1);
            }
        }
        if (npc.isRegistered()) {
            World.getNpcs().remove(npc);
        }
    }
}
