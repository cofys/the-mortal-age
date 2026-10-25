import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";
import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import { parseConfigValue } from "@runelite/client/config/ConfigManager";
import { TileMarkersConfig } from "./TileMarkersConfig";

/** The plugin's settings before Tile Indicators parity (group "tilemarkers"), kept for migrations. */
export const LegacyTileMarkersConfig = ConfigGroup("tilemarkers", {
    showDestinationTile: ConfigItem({ name: "Highlight destination tile", default: true }),
    showCurrentTile: ConfigItem({ name: "Highlight true tile", default: true }),
    destinationTileColor: ConfigItem({ name: "Destination tile color", color: true, default: 0xa9a753 }),
    currentTileColor: ConfigItem({ name: "True tile color", color: true, default: 0x808080 }),
});

const MIGRATION = "tileindicators";
const MOVES: [keyof typeof LegacyTileMarkersConfig.items, keyof typeof TileMarkersConfig.items, boolean][] = [
    ["showDestinationTile", "highlightDestinationTile", false],
    ["showCurrentTile", "highlightCurrentTile", false],
    ["destinationTileColor", "highlightDestinationColor", true],
    ["currentTileColor", "highlightCurrentColor", true],
];

/**
 * Once: the old Tile Markers settings someone saved move to RuneLite's Tile Indicators keys
 * (their colours had no alpha, so they move as opaque colours), and a saved on/off moves to
 * the new plugin key. Unsaved settings take RuneLite's defaults.
 */
export function migrateTileMarkersConfig(configManager: ConfigManager): void {
    if (configManager.isMigrated(MIGRATION)) return;
    for (const [from, to, isColor] of MOVES) {
        const raw = configManager.getConfiguration(LegacyTileMarkersConfig.group, from);
        if (raw === undefined) continue;
        if (configManager.getConfiguration(TileMarkersConfig.group, to) === undefined) {
            let value = parseConfigValue(LegacyTileMarkersConfig.items[from], raw);
            if (isColor) value = (0xff000000 | (Number(value) & 0xffffff)) >>> 0;
            configManager.setConfigValue(TileMarkersConfig, to, value);
        }
        configManager.unsetConfiguration(LegacyTileMarkersConfig.group, from);
    }
    const enabled = configManager.getConfiguration("runelite", "tilemarkersplugin");
    if (enabled !== undefined) {
        if (configManager.getConfiguration("runelite", "tileindicatorsplugin") === undefined) {
            configManager.setConfiguration("runelite", "tileindicatorsplugin", enabled);
        }
        configManager.unsetConfiguration("runelite", "tilemarkersplugin");
    }
    configManager.markMigrated(MIGRATION);
}
