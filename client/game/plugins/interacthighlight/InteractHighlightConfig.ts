import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";
import type { ConfigManager } from "@runelite/client/config/ConfigManager";

// The first four keys predate the Items section and still cover NPCs and objects, so saved
// settings carry over.
export const InteractHighlightConfig = ConfigGroup(
    "interacthighlight",
    {
        showHover: ConfigItem({
            name: "Show hover highlight",
            section: "world",
            position: 1,
            default: true,
        }),
        showInteract: ConfigItem({
            name: "Show interaction highlight",
            section: "world",
            position: 2,
            default: true,
        }),
        hoverColor: ConfigItem({
            name: "Hover color",
            color: true,
            section: "world",
            position: 3,
            default: 0x00ffff,
        }),
        interactColor: ConfigItem({
            name: "Interact color",
            color: true,
            section: "world",
            position: 4,
            default: 0xff0000,
        }),
        itemShowHover: ConfigItem({
            name: "Show on hover",
            section: "items",
            position: 5,
            default: true,
        }),
        itemShowInteract: ConfigItem({
            name: "Show on interact",
            section: "items",
            position: 6,
            default: true,
        }),
        itemHoverColor: ConfigItem({
            name: "Item hover",
            color: true,
            section: "items",
            position: 7,
            default: 0x00ffff,
        }),
        itemInteractColor: ConfigItem({
            name: "Item interact",
            color: true,
            section: "items",
            position: 8,
            default: 0xff0000,
        }),
    },
    {
        sections: {
            world: { name: "NPCs and objects", position: 0 },
            items: { name: "Items", position: 1 },
        },
    },
);

export interface InteractHighlightPluginConfig {
    enabled: boolean;
    showHover: boolean;
    showInteract: boolean;
    hoverColor: number;
    interactColor: number;
    itemShowHover: boolean;
    itemShowInteract: boolean;
    itemHoverColor: number;
    itemInteractColor: number;
}

export interface InteractHighlightPluginState {
    config: InteractHighlightPluginConfig;
    version: number;
}

export function readInteractHighlightConfig(
    configManager: ConfigManager,
    enabled: boolean,
): InteractHighlightPluginConfig {
    const config = configManager.getConfig(InteractHighlightConfig);
    return {
        enabled,
        showHover: config.showHover(),
        showInteract: config.showInteract(),
        hoverColor: config.hoverColor(),
        interactColor: config.interactColor(),
        itemShowHover: config.itemShowHover(),
        itemShowInteract: config.itemShowInteract(),
        itemHoverColor: config.itemHoverColor(),
        itemInteractColor: config.itemInteractColor(),
    };
}
