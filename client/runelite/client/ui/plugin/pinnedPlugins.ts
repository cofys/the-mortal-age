import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import { RuneLiteConfig } from "@runelite/client/config/RuneLiteConfig";

/** The starred plugins' names (RuneLite's `runelite.pinnedPlugins`, comma-separated). */
export function getPinnedPlugins(configManager: ConfigManager): Set<string> {
    const raw: string = configManager.getConfig(RuneLiteConfig).pinnedPlugins() ?? "";
    return new Set(
        raw
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
    );
}

export function setPluginPinned(configManager: ConfigManager, name: string, pinned: boolean): void {
    const names = getPinnedPlugins(configManager);
    if (pinned) names.add(name);
    else names.delete(name);
    configManager.setConfigValue(RuneLiteConfig, "pinnedPlugins", [...names].sort().join(","));
}

/**
 * RuneLite's plugin list order (`PluginSearch`): pinned first; with a search, then an exact name,
 * a name word starting with it, the name containing it, and other matches (description, tags);
 * then by name.
 */
export function comparePlugins(
    a: { name: string; pinned: boolean },
    b: { name: string; pinned: boolean },
    needle: string,
): number {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (needle) {
        const rank = (name: string): number => {
            const lower = name.toLowerCase();
            if (lower === needle) return 0;
            if (lower.split(/\s+/).some((word) => word.startsWith(needle))) return 1;
            if (lower.includes(needle)) return 2;
            return 3;
        };
        const byRank = rank(a.name) - rank(b.name);
        if (byRank !== 0) return byRank;
    }
    return a.name.localeCompare(b.name);
}
