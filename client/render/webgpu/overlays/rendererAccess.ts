import type { WebGPURenderer } from "../WebGPURenderer";
import type { WorldResources } from "../WorldResources";

/**
 * WebGPURenderer keeps `world` private (stage-4 files must not edit it); the field is a plain
 * TS private, so reading it through a cast is safe at runtime.
 */
export function getWorldResources(renderer: WebGPURenderer): WorldResources | undefined {
    return (renderer as unknown as { world?: WorldResources }).world;
}
