import type { BuildSteps } from "../../common/utils/BuildSteps";
import { SerializerImplementation } from "threads";

import { SdMapDataLoader } from "../../render/loader/SdMapDataLoader";
import { WorkerState } from "./RenderDataWorker";

export type RenderDataResult<T> = {
    data: T;
    transferables: Transferable[];
};

export interface RenderDataLoader<I, D> {
    // Used by serializer
    __type: keyof RenderDataLoaders;

    init(): void;

    load(state: WorkerState, input: I, build?: BuildSteps): Promise<RenderDataResult<D>>;

    shouldClearWorkerCacheAfterLoad?(input: I): boolean;

    reset(): void;
}

const loaders = {
    sdMapDataLoader: new SdMapDataLoader(),
};

type RenderDataLoaders = typeof loaders;

const loaderSerializerNamePrefix = "$RenderDataLoader$";

export const renderDataLoaderSerializer: SerializerImplementation = {
    serialize(value, defaultHandler) {
        if (value && value.__type) {
            return loaderSerializerNamePrefix + value.__type;
        } else {
            return defaultHandler(value);
        }
    },
    deserialize(value, defaultHandler) {
        if (value && typeof value === "string" && value.startsWith(loaderSerializerNamePrefix)) {
            const type = value.substring(loaderSerializerNamePrefix.length);
            if (type in loaders) {
                return loaders[type as keyof RenderDataLoaders];
            }
            throw new Error("Unknown loader type: " + type);
        } else {
            return defaultHandler(value);
        }
    },
};
