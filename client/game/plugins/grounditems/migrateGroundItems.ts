import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import { GroundItemsConfig } from "./GroundItemsConfig";

const GROUP = GroundItemsConfig.group;
const MIGRATION = "grounditems.runelite";

/** Earlier saved enum values (the old dropdown labels, or the lowercase values) to RuneLite's names. */
const ENUM_VALUES: Record<string, string> = {
    both: "BOTH", "grand exchange": "GE", ge: "GE", "high alchemy": "HA", ha: "HA", off: "OFF",
    highest: "HIGHEST", all: "ALL", takeable: "TAKEABLE", drops: "DROPS", ticks: "TICKS", seconds: "SECONDS",
};

/** Old key -> RuneLite key, for the settings that were stored under other names. */
const RENAMED: Record<string, string> = {
    rightClickHidden: "deprioritizeHiddenItems",
    valueCalculationMode: "highlightValueCalculation",
    despawnTimerMode: "groundItemTimers",
};

const ENUM_KEYS = ["priceDisplayMode", "highlightValueCalculation", "ownershipFilterMode", "groundItemTimers"];
const COLOR_KEYS = [
    "defaultColor", "highlightedColor", "hiddenColor",
    "lowValueColor", "mediumValueColor", "highValueColor", "insaneValueColor",
];

/**
 * Once: the plugin's earlier settings move to RuneLite's. Three keys are renamed, enum values
 * become RuneLite's names, and colours saved without alpha become opaque.
 */
export function migrateGroundItemsConfig(configManager: ConfigManager): void {
    if (configManager.isMigrated(MIGRATION)) return;
    for (const [from, to] of Object.entries(RENAMED)) {
        const value = configManager.getConfiguration(GROUP, from);
        if (value === undefined) continue;
        if (configManager.getConfiguration(GROUP, to) === undefined) configManager.setConfiguration(GROUP, to, value);
        configManager.unsetConfiguration(GROUP, from);
    }
    for (const key of ENUM_KEYS) {
        const value = configManager.getConfiguration(GROUP, key);
        const mapped = value === undefined ? undefined : ENUM_VALUES[value.trim().toLowerCase()];
        if (mapped && mapped !== value) configManager.setConfiguration(GROUP, key, mapped);
    }
    for (const key of COLOR_KEYS) {
        const value = configManager.getConfiguration(GROUP, key);
        if (value !== undefined && /^#[0-9a-f]{6}$/i.test(value)) configManager.setConfiguration(GROUP, key, `#ff${value.slice(1)}`);
    }
    configManager.markMigrated(MIGRATION);
}
