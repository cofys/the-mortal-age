import { ArchivedDefinitionRegistry } from "../../rs/config/ArchivedDefinitionRegistry";
import type { ArchivedDefinitionBundle, ArchivedDefinitionContext } from "../../rs/config/ArchivedDefinitionRegistry";
import { crc32 } from "../../rs/util/Crc32";

/** Each browser/worker owns a snapshot; validation waits for its real cache context. */
let bundles: readonly ArchivedDefinitionBundle[] = [];
let generation = 0;
let cacheKey = "";

export function replaceDefinitionArchives(input: readonly ArchivedDefinitionBundle[]): void {
    if (!Array.isArray(input)) throw new Error("Archived bundles must be an array");
    const json = JSON.stringify(input);
    bundles = JSON.parse(json);
    cacheKey = input.length ? crc32(new TextEncoder().encode(json)).toString(36) : "";
    generation++;
}

export function getDefinitionArchives(): readonly ArchivedDefinitionBundle[] {
    return JSON.parse(JSON.stringify(bundles));
}

export function getDefinitionArchiveKey(): string { return cacheKey; }

/** A factory keeps its cache-bound validator; obsolete factories never supply a new context. */
export function createDefinitionArchiveView(context: ArchivedDefinitionContext): () => ArchivedDefinitionRegistry {
    let current = new ArchivedDefinitionRegistry(context);
    let seen = -1;
    return () => {
        if (seen !== generation) {
            const candidate = new ArchivedDefinitionRegistry(context);
            candidate.replace(bundles);
            current = candidate;
            seen = generation;
        }
        return current;
    };
}
