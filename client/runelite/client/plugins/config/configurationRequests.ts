import type { PluginClass } from "../Plugin";

type Listener = (pluginClass: PluginClass) => void;

let pending: PluginClass | undefined;
const listeners = new Set<Listener>();

/**
 * Opens a plugin's settings in the Configuration panel (RuneLite's
 * ConfigPlugin.openConfigurationPanel), e.g. from an overlay's "Configure" menu entry.
 * Only an active listener can defer a request until its panel mounts.
 */
export function openConfiguration(pluginClass: PluginClass): void {
    if (listeners.size === 0) return;
    pending = pluginClass;
    for (const listener of listeners) listener(pluginClass);
}

/** The Configuration plugin and its panel listen; returns the unsubscribe function. */
export function onConfigurationRequest(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) pending = undefined;
    };
}

/** A request made before the panel was showing; taken once. */
export function takePendingConfiguration(): PluginClass | undefined {
    const request = pending;
    pending = undefined;
    return request;
}
