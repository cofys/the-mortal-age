import { Task } from "../Task";
import { NPC } from "../../entity/impl/npc/NPC";
import { NpcSpawnLineage } from "../../entity/impl/npc/NpcSpawnLineage";
import { World } from "../../World";

export class NPCRespawnTask extends Task {
    private npc: NPC;
    constructor(npc: NPC, ticks: number) {
    super(ticks);
    this.npc = npc;
    }

    public execute() {
        this.stop();
        // Its source was reloaded or removed: the replacement is already in the world.
        if (this.npc.getSpawnLineage()?.isRetired()) {
            return;
        }
        const clone = this.npc.clone();
        const key = this.npc.getUniqueKey();
        // A unique NPC another spawn already brought back stays single.
        if (key !== null && !NpcSpawnLineage.claimUnique(key, clone)) {
            return;
        }
        World.getAddNPCQueue().push(clone);
    }
}
