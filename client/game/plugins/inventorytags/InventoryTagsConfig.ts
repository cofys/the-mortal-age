import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** RuneLite 1.13.3 InventoryTagsConfig: group, keys and defaults as in RuneLite. */
export const InventoryTagsConfig = ConfigGroup(
    "inventorytags",
    {
        showTagOutline: ConfigItem({
            name: "Outline",
            description: "Configures whether or not item tags should be outlined",
            section: "tagStyle",
            position: 0,
            default: true,
        }),
        tagUnderline: ConfigItem({
            name: "Underline",
            description: "Configures whether or not item tags should be underlined",
            section: "tagStyle",
            position: 1,
            default: false,
        }),
        tagFill: ConfigItem({
            name: "Fill",
            description: "Configures whether or not item tags should be filled",
            section: "tagStyle",
            position: 2,
            default: false,
        }),
        fillOpacity: ConfigItem({
            name: "Fill opacity",
            description: "Configures the opacity of the tag \"Fill\"",
            section: "tagStyle",
            position: 3,
            range: { min: 0, max: 255 },
            default: 50,
        }),
    },
    {
        sections: {
            tagStyle: { name: "Tag display mode", position: 0 },
        },
    },
);

/** The display flags and fill alpha the overlay draws with (fill opacity clamped to 0-255). */
export type InventoryTagsDisplay = {
    outline: boolean;
    underline: boolean;
    fill: boolean;
    fillOpacity: number;
};

export function clampFillOpacity(value: unknown): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 50;
}
