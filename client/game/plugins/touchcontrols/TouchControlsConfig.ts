import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** When the joystick shows. Default = whatever the device reports. */
export const PadMode = {
    DEFAULT: "DEFAULT",
    ON: "ON",
    OFF: "OFF",
} as const;
export type PadModeValue = (typeof PadMode)[keyof typeof PadMode];

/** Settings shown in the Touch Controls panel (Plugin list → gear). */
export const TouchControlsConfig = ConfigGroup(
    "touchcontrols",
    {
        padMode: ConfigItem<PadModeValue>({
            name: "Show the joystick",
            description:
                "Default shows the joystick on touch screens; On forces it on any device; Off hides it.",
            position: 0,
            enum: {
                Default: PadMode.DEFAULT,
                On: PadMode.ON,
                Off: PadMode.OFF,
            },
            default: PadMode.DEFAULT,
        }),
    },
);
