import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/**
 * Tile Packs' TilePacksConfig: group, keys (typo included), names and defaults as in the Plugin
 * Hub plugin. None has a position, so RuneLite lists them by name; they are declared in that
 * order. Pack state is kept in the separate "tilePacks" group (see TilePackStore).
 */
export const TilePacksConfig = ConfigGroup("tilepacks", {
    borderWidth: ConfigItem({
        name: "Border Width",
        description: "Width of the marked tile border",
        step: 0.1,
        default: 2,
    }),
    drawTilesOnMinimmap: ConfigItem({
        name: "Draw tiles on minimap",
        description: "Configures whether tile packs tiles should be drawn on minimap",
        default: false,
    }),
    fillOpacity: ConfigItem({
        name: "Fill Opacity",
        description: "Opacity of the tile fill color",
        default: 50,
    }),
    hidePlugin: ConfigItem({
        name: "Hide on toolbar",
        description: "When checked, the plugin will not appear in the tool bar",
        default: false,
    }),
    overrideColor: ConfigItem({
        name: "Override Color",
        description: "If Use Override Color is checked, all tiles will be this color.",
        color: true,
        alpha: true,
        default: 0xffffff00,
    }),
    overrideColorActive: ConfigItem({
        name: "Override Color Active",
        description: "When checked, all tiles will render as the selected color",
        default: false,
    }),
    showLabels: ConfigItem({
        name: "Show Labels",
        description: "When checked, labels will render as defined in each pack",
        default: true,
    }),
});
