import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** RuneLite 1.13.3 NpcIndicatorsConfig: group, keys, defaults and order as in RuneLite. */
export const NpcIndicatorsConfig = ConfigGroup(
    "npcindicators",
    {
        highlightHull: ConfigItem({
            name: "Highlight hull",
            description: "Configures whether or not NPC should be highlighted by hull.",
            section: "renderStyleSection",
            position: 0,
            default: true,
        }),
        highlightTile: ConfigItem({
            name: "Highlight tile",
            description: "Configures whether or not NPC should be highlighted by tile.",
            section: "renderStyleSection",
            position: 1,
            default: false,
        }),
        highlightTrueTile: ConfigItem({
            name: "Highlight true tile",
            description: "Configures whether or not NPC should be highlighted by true tile.",
            section: "renderStyleSection",
            position: 2,
            default: false,
        }),
        highlightSouthWestTile: ConfigItem({
            name: "Highlight south west tile",
            description: "Configures whether or not NPC should be highlighted by south western tile.",
            section: "renderStyleSection",
            position: 3,
            default: false,
        }),
        highlightSouthWestTrueTile: ConfigItem({
            name: "Highlight south west true tile",
            description: "Configures whether or not NPC should be highlighted by south western true tile.",
            section: "renderStyleSection",
            position: 4,
            default: false,
        }),
        highlightOutline: ConfigItem({
            name: "Highlight outline",
            description: "Configures whether or not the model of the NPC should be highlighted by outline.",
            section: "renderStyleSection",
            position: 5,
            default: false,
        }),
        highlightColor: ConfigItem({
            keyName: "npcColor",
            name: "Highlight color",
            description: "Color of the NPC highlight border, menu, and text.",
            section: "renderStyleSection",
            position: 10,
            color: true,
            alpha: true,
            default: 0xff00ffff,
        }),
        fillColor: ConfigItem({
            name: "Fill color",
            description: "Color of the NPC highlight fill.",
            section: "renderStyleSection",
            position: 11,
            color: true,
            alpha: true,
            default: 0x1400ffff,
        }),
        borderWidth: ConfigItem({
            name: "Border width",
            description: "Width of the highlighted NPC border.",
            section: "renderStyleSection",
            position: 12,
            step: 0.1,
            default: 2,
        }),
        outlineFeather: ConfigItem({
            name: "Outline feather",
            description: "Specify between 0-4 how much of the model outline should be faded.",
            section: "renderStyleSection",
            position: 13,
            range: { min: 0, max: 4 },
            default: 0,
        }),
        npcToHighlight: ConfigItem({
            name: "NPCs to highlight",
            description: "List of NPC names to highlight. Format: npc1, npc2, npc3",
            position: 7,
            default: "",
        }),
        drawNames: ConfigItem({
            name: "Draw names above NPC",
            description: "Configures whether or not NPC names should be drawn above the NPC.",
            position: 8,
            default: false,
        }),
        drawMinimapNames: ConfigItem({
            name: "Draw names on minimap",
            description: "Configures whether or not NPC names should be drawn on the minimap.",
            position: 9,
            default: false,
        }),
        highlightMenuStyle: ConfigItem({
            name: "Highlight menu style",
            description: "Highlight style in the right-click menu.",
            position: 10,
            enum: { NONE: "NONE", LEVEL: "LEVEL", NAME: "NAME", BOTH: "BOTH" },
            default: "NONE",
        }),
        ignoreDeadNpcs: ConfigItem({
            name: "Ignore dead NPCs",
            description: "Prevents highlighting NPCs after they are dead.",
            position: 11,
            default: true,
        }),
        deadNpcMenuColor: ConfigItem({
            name: "Dead NPC menu color",
            description: "Color of the NPC menus for dead NPCs.",
            position: 12,
            color: true,
            alpha: true,
            default: -1,
        }),
        showRespawnTimer: ConfigItem({
            name: "Show respawn timer",
            description: "Show respawn timer of tagged NPCs.",
            position: 13,
            default: false,
        }),
        ignorePets: ConfigItem({
            name: "Ignore pets",
            description: "Excludes pets from being highlighted.",
            position: 14,
            default: true,
        }),
    },
    {
        sections: {
            renderStyleSection: { name: "Render style", position: 0 },
        },
    },
);

/** A config colour (0xAARRGGBB; no alpha bits means opaque) as renderer RGBA 0-1. */
export function argbToRgba(argb: number): [number, number, number, number] {
    const v = argb >>> 0;
    const a = v >>> 24 || 255;
    return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255, a / 255];
}
