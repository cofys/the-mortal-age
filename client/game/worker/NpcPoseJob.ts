import { DynamicNpcAnimLoader, npcAppearanceKey, type DynamicNpcFrameGeometry, type NpcFrameRequest } from "../../render/npc/DynamicNpcAnimLoader";
import type { WorkerState } from "./RenderDataWorker";
import { isGroupMissingError } from "../../rs/cache/js5/GroupMissingError";

export type NpcPoseInput = {
    context: string;
    key: string;
    appearance: string;
    request: NpcFrameRequest;
    textures: Array<[number, number]>;
};
export type NpcPoseResult = DynamicNpcFrameGeometry | { busy: true };

/** One nonblocking attempt on an existing cache worker; JS5 misses retry from the caller. */
export class NpcPoseJob {
    private loader?: DynamicNpcAnimLoader;
    private context?: string;
    private disposed = false;
    private readonly appearances = new Map<number, string>();

    constructor(private readonly state: WorkerState) {}

    async load(input: NpcPoseInput): Promise<NpcPoseResult | undefined> {
        // Let queued foreground RPCs enter first. Never hold the scene worker during JS5 waits.
        await new Promise(resolve => setTimeout(resolve, 0));
        const state = this.state;
        if (this.disposed) return undefined;
        if (state.scenePasses > 0) return { busy: true };
        if (this.context !== input.context) {
            this.loader?.clear();
            state.npcModelLoader.clearCache();
            this.loader = new DynamicNpcAnimLoader(state.npcTypeLoader, state.npcModelLoader.modelLoader,
                state.textureLoader, state.seqTypeLoader, state.seqFrameLoader, state.skeletalSeqLoader,
                state.varManager, state.npcModelLoader);
            this.loader.setTextureIdIndexMap(new Map(input.textures));
            this.context = input.context;
        }
        const loader = this.loader!;
        const misses = state.js5?.store.missCount;
        try {
            const type = loader.getResolvedNpcType(input.request[0]);
            // A var/appearance update received while a request was queued cannot publish a different NPC.
            if (!type || npcAppearanceKey(type) !== input.appearance) return undefined;
            if (this.appearances.get(type.id) !== input.appearance) {
                state.npcModelLoader.modelCache.delete(type.id);
                this.appearances.set(type.id, input.appearance);
                if (this.appearances.size > 128) this.appearances.delete(this.appearances.keys().next().value!);
            }
            const geometry = input.request[1] < 0 ? loader.getBaseGeometry(type.id)
                : loader.getFrameGeometry(...input.request);
            if (!geometry) return undefined;
            loader.takeGeometry(geometry.key);
            if (this.disposed || state.js5?.store.missCount !== misses) return undefined;
            if ((!geometry.opaqueVertices.length || !geometry.opaqueIndices.length) &&
                (!geometry.alphaVertices.length || !geometry.alphaIndices.length)) return undefined;
            const normalized = loader.getAsyncPoseRequest(...input.request);
            if (!normalized || normalized.key !== geometry.key ||
                JSON.stringify(normalized.request) !== JSON.stringify(input.request)) return undefined;
            return { ...geometry, key: input.key };
        } catch (error) {
            // Sparse loaders may throw instead of returning a miss. Their existing onMiss queues JS5.
            if (isGroupMissingError(error)) {
                void state.js5?.requestGroup(error.indexId, error.archiveId).catch(() => {});
                return undefined;
            }
            if (state.js5?.store.missCount !== misses) return undefined;
            throw error;
        } finally {
            // Reuse the shared model cache, with a small bound between foreground scene clears.
            while (state.npcModelLoader.modelCache.size > 32) {
                state.npcModelLoader.modelCache.delete(state.npcModelLoader.modelCache.keys().next().value!);
            }
        }
    }

    dispose(): void { this.disposed = true; this.loader?.clear(); }
}
