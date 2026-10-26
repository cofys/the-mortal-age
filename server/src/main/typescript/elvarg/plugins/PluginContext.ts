/**
 * The plugin whose code is running: set while its hooks, areas, commands and register()
 * run, and carried into the tasks it submits, so core can record which plugin changed the
 * world (the objects it spawned) without every call site saying so.
 */
export class PluginContext {
    private static active: string | null = null;

    public static current(): string | null {
        return PluginContext.active;
    }

    /** Makes `pluginName` current and returns the one before, for {@link exit}. */
    public static enter(pluginName: string | null): string | null {
        const previous = PluginContext.active;
        PluginContext.active = pluginName;
        return previous;
    }

    public static exit(previous: string | null): void {
        PluginContext.active = previous;
    }
}
