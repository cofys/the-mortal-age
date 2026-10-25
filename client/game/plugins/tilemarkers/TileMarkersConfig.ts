import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** RuneLite's new Color(0, 0, 0, 50): every tile's default fill. */
const DEFAULT_FILL = 0x32000000;

/**
 * RuneLite 1.13.3 TileIndicatorsConfig: group, sections, keys, names, descriptions, positions
 * and defaults as in RuneLite. The files keep the plugin's old Tile Markers name.
 */
export const TileMarkersConfig = ConfigGroup(
    "tileindicators",
    {
        highlightDestinationTile: ConfigItem({
            name: "Highlight destination tile",
            description: "Highlights tile player is walking to.",
            section: "destinationTile",
            position: 1,
            default: true,
        }),
        highlightDestinationColor: ConfigItem({
            name: "Highlight color",
            description: "Configures the highlight color of current destination.",
            section: "destinationTile",
            position: 2,
            color: true,
            alpha: true,
            default: 0xff808080,
        }),
        destinationTileFillColor: ConfigItem({
            name: "Fill color",
            description: "Configures the fill color of destination tile.",
            section: "destinationTile",
            position: 3,
            color: true,
            alpha: true,
            default: DEFAULT_FILL,
        }),
        destinationTileBorderWidth: ConfigItem({
            name: "Border width",
            description: "Width of the destination tile marker border.",
            section: "destinationTile",
            position: 4,
            step: 0.1,
            default: 2,
        }),
        highlightHoveredTile: ConfigItem({
            name: "Highlight hovered tile",
            description: "Highlights tile player is hovering with mouse.",
            section: "hoveredTile",
            position: 1,
            default: false,
        }),
        highlightHoveredColor: ConfigItem({
            name: "Highlight color",
            description: "Configures the highlight color of hovered tile.",
            section: "hoveredTile",
            position: 2,
            color: true,
            alpha: true,
            default: 0x00000000,
        }),
        hoveredTileFillColor: ConfigItem({
            name: "Fill color",
            description: "Configures the fill color of hovered tile.",
            section: "hoveredTile",
            position: 3,
            color: true,
            alpha: true,
            default: DEFAULT_FILL,
        }),
        hoveredTileBorderWidth: ConfigItem({
            name: "Border width",
            description: "Width of the hovered tile marker border.",
            section: "hoveredTile",
            position: 4,
            step: 0.1,
            default: 2,
        }),
        highlightCurrentTile: ConfigItem({
            name: "Highlight true tile",
            description: "Highlights true tile player is on as seen by server.",
            section: "currentTile",
            position: 1,
            default: false,
        }),
        highlightCurrentColor: ConfigItem({
            name: "Highlight color",
            description: "Configures the highlight color of current true tile.",
            section: "currentTile",
            position: 2,
            color: true,
            alpha: true,
            default: 0xff00ffff,
        }),
        currentTileFillColor: ConfigItem({
            name: "Fill color",
            description: "Configures the fill color of current true tile.",
            section: "currentTile",
            position: 3,
            color: true,
            alpha: true,
            default: DEFAULT_FILL,
        }),
        currentTileBorderWidth: ConfigItem({
            name: "Border width",
            description: "Width of the true tile marker border.",
            section: "currentTile",
            position: 4,
            step: 0.1,
            default: 2,
        }),
    },
    {
        sections: {
            destinationTile: { name: "Destination tile", position: 0 },
            hoveredTile: { name: "Hovered tile", position: 1 },
            currentTile: { name: "Current tile", position: 2 },
        },
    },
);
