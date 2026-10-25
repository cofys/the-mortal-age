import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

export const SHOW_IMPORT_EXPORT_KEY_NAME = "showImportExport";

/**
 * RuneLite 1.13.3 GroundMarkerConfig: group, keys, names and defaults as in RuneLite. None has a
 * position, so RuneLite lists them by name; they are declared in that order.
 */
export const GroundMarkerConfig = ConfigGroup("groundMarker", {
    borderWidth: ConfigItem({
        name: "Border width",
        description: "Width of the marked tile border.",
        step: 0.1,
        default: 2,
    }),
    drawTileOnMinimmap: ConfigItem({
        keyName: "drawOnMinimap",
        name: "Draw tiles on minimap",
        description: "Configures whether marked tiles should be drawn on minimap.",
        default: false,
    }),
    fillOpacity: ConfigItem({
        name: "Fill opacity",
        description: "Opacity of the tile fill color.",
        range: { max: 255 },
        default: 50,
    }),
    showImportExport: ConfigItem({
        keyName: SHOW_IMPORT_EXPORT_KEY_NAME,
        name: "Show import/export/clear options",
        description: "Show the Import, Export, and Clear options on the world map orb right-click menu.",
        default: true,
    }),
    markerColor: ConfigItem({
        name: "Tile color",
        description: "The default color for marked tiles.",
        color: true,
        alpha: true,
        default: 0xffffff00,
    }),
});
