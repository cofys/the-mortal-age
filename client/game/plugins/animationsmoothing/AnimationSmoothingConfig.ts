import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

export const AnimationSmoothingConfig = ConfigGroup("animationsmoothing", {
    players: ConfigItem({ name: "Players", default: true, position: 0 }),
    npcs: ConfigItem({ name: "NPCs", default: true, position: 1 }),
    graphics: ConfigItem({ name: "Graphics and projectiles", default: true, position: 2 }),
    objects: ConfigItem({ name: "Scenery", default: true, position: 3 }),
    sceneryQuality: ConfigItem({
        name: "Scenery quality",
        description: "Higher quality adds intermediate poses and uses more memory. Nearby scenery reloads when changed.",
        enum: { Balanced: 4, High: 8, Maximum: 0 },
        default: 4,
        position: 4,
    }),
});
