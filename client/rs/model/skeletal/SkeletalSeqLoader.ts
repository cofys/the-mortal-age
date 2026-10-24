import { Archive } from "../../cache/Archive";
import { CacheIndex } from "../../cache/CacheIndex";
import { isGroupMissingError } from "../../cache/js5/GroupMissingError";
import { SeqBaseLoader } from "../seq/SeqBaseLoader";
import { SkeletalSeq } from "./SkeletalSeq";

export interface SkeletalSeqLoader {
    load(id: number): SkeletalSeq | undefined;

    clearCache(): void;
}

export class IndexSkeletalSeqLoader implements SkeletalSeqLoader {
    seqs: Map<number, SkeletalSeq> = new Map();

    archiveCache: Map<number, Archive> = new Map();

    constructor(
        readonly animIndex: CacheIndex,
        readonly baseLoader: SeqBaseLoader,
    ) {}

    load(id: number): SkeletalSeq | undefined {
        const cached = this.seqs.get(id);
        if (cached) {
            return cached;
        }

        const archiveId = id >> 16;
        const fileId = id & 0xffff;

        let archive = this.archiveCache.get(archiveId);
        if (!archive) {
            try {
                archive = this.animIndex.getArchive(archiveId);
            } catch (e) {
                // Group not downloaded yet (fetch already queued); render a
                // static pose until it arrives.
                if (!isGroupMissingError(e)) {
                    throw e;
                }
                return undefined;
            }
            this.archiveCache.set(archiveId, archive);
        }

        const file = archive.getFile(fileId);
        if (!file) {
            return undefined;
        }

        try {
            const skeletalSeq = SkeletalSeq.load(this.baseLoader, id, file.data);
            this.seqs.set(id, skeletalSeq);
            return skeletalSeq;
        } catch (e) {
            if (!isGroupMissingError(e)) throw e;
            return undefined;
        }
    }

    clearCache(): void {
        this.seqs.clear();
        this.archiveCache.clear();
    }
}
