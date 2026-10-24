import { NpcChanged, NpcDespawned, NpcSpawned } from "@runelite/api/events";
import type { NpcEcs } from "../../game/ecs/NpcEcs";

/**
 * Posts NpcSpawned/NpcDespawned/NpcChanged from the NPC store's mutations: server NPCs only
 * (as RuneLite sees them), and a despawn only for an NPC whose spawn was posted. Returns the
 * unbind function.
 */
export function bindNpcEvents(npcs: NpcEcs, post: (event: object) => void): () => void {
    const spawned = new Map<number, number>();
    const ref = (ecsId: number, index: number) => ({ ecsId, index, id: npcs.getNpcTypeId(ecsId) | 0 });
    const listener = (mutation: { index: number; kind: string; oldId?: number }) => {
        const ecsId = mutation.index | 0;
        if (mutation.kind === "spawn") {
            const index = npcs.getServerId(ecsId) | 0;
            if (index <= 0) return;
            spawned.set(ecsId, index);
            post(new NpcSpawned(ref(ecsId, index)));
        } else if (mutation.kind === "despawn") {
            const index = spawned.get(ecsId);
            if (index === undefined) return;
            spawned.delete(ecsId);
            post(new NpcDespawned(ref(ecsId, index)));
        } else if (mutation.kind === "composition") {
            const index = spawned.get(ecsId);
            if (index !== undefined) post(new NpcChanged(ref(ecsId, index), mutation.oldId ?? -1));
        }
    };
    npcs.mutationListeners.add(listener);
    return () => npcs.mutationListeners.delete(listener);
}
