import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** RuneLite 1.13.3 ObjectIndicatorsConfig: group, keys, names, defaults and order as in RuneLite. */
export const ObjectIndicatorsConfig = ConfigGroup(
    "objectindicators",
    {
        highlightHull: ConfigItem({
            name: "Highlight hull",
            description: "Configures whether or not object should be highlighted by hull.",
            section: "renderStyleSection",
            position: 0,
            default: true,
        }),
        highlightOutline: ConfigItem({
            name: "Highlight outline",
            description: "Configures whether or not the model of the object should be highlighted by outline.",
            section: "renderStyleSection",
            position: 1,
            default: false,
        }),
        highlightClickbox: ConfigItem({
            name: "Highlight clickbox",
            description: "Configures whether the object's clickbox should be highlighted.",
            section: "renderStyleSection",
            position: 2,
            default: false,
        }),
        highlightTile: ConfigItem({
            name: "Highlight tile",
            description: "Configures whether the object's tile should be highlighted.",
            section: "renderStyleSection",
            position: 3,
            default: false,
        }),
        markerColor: ConfigItem({
            name: "Marker color",
            description: "Configures the color of newly created object markers.",
            section: "renderStyleSection",
            position: 4,
            color: true,
            alpha: true,
            default: 0xffffff00,
        }),
        fillColor: ConfigItem({
            name: "Fill color",
            description: "Configures the fill color of newly created object markers.",
            section: "renderStyleSection",
            position: 5,
            color: true,
            alpha: true,
            // RuneLite declares no default: unset until chosen.
            default: -1,
        }),
        borderWidth: ConfigItem({
            name: "Border width",
            description: "Width of the marked object border.",
            section: "renderStyleSection",
            position: 6,
            step: 0.1,
            default: 2,
        }),
        outlineFeather: ConfigItem({
            name: "Outline feather",
            description: "Specify between 0-4 how much of the model outline should be faded.",
            section: "renderStyleSection",
            position: 7,
            range: { min: 0, max: 4 },
            default: 0,
        }),
    },
    {
        sections: {
            renderStyleSection: { name: "Render style", position: 0 },
        },
    },
);
