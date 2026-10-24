import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** RuneLite's XpPanelLabel: what an info box or canvas line shows. Stored by enum name. */
export const XP_PANEL_LABELS = {
    TIME_TO_LEVEL: "TTL",
    XP_GAINED: "XP Gained",
    XP_HOUR: "XP/hr",
    XP_LEFT: "XP Left",
    ACTIONS_LEFT: "Actions",
    ACTIONS_HOUR: "Actions/hr",
    ACTIONS_DONE: "Actions Done",
} as const;
export type XpPanelLabel = keyof typeof XP_PANEL_LABELS;

/** RuneLite's XpProgressBarLabel. */
export const XP_PROGRESS_BAR_LABELS = {
    PERCENTAGE: "Percentage",
    TIME_TO_LEVEL: "Time to level",
    HOURS_TO_LEVEL: "Hours to level",
} as const;
export type XpProgressBarLabel = keyof typeof XP_PROGRESS_BAR_LABELS;

const labelOptions = Object.fromEntries(Object.entries(XP_PANEL_LABELS).map(([value, label]) => [label, value]));
const progressOptions = Object.fromEntries(
    Object.entries(XP_PROGRESS_BAR_LABELS).map(([value, label]) => [label, value]),
);

/** RuneLite 1.13.3 XpTrackerConfig: group, keys, defaults and order as in RuneLite. */
export const XpTrackerConfig = ConfigGroup(
    "xpTracker",
    {
        saveState: ConfigItem({
            name: "Save between sessions",
            description: "Saves xp trackers between sessions.",
            position: -1,
            default: true,
        }),
        hideMaxed: ConfigItem({
            name: "Hide maxed skills",
            description: "XP tracker will no longer track level 99 skills.",
            position: 0,
            default: false,
        }),
        logoutPausing: ConfigItem({
            name: "Pause on logout",
            description: "Configures whether skills should pause on logout.",
            position: 1,
            default: true,
        }),
        intermediateLevelMarkers: ConfigItem({
            name: "Show intermediate level markers",
            description: "Marks intermediate levels on the progress bar.",
            position: 2,
            default: false,
        }),
        pauseSkillAfter: ConfigItem({
            name: "Auto pause after",
            description:
                "Configures how many minutes passes before pausing a skill while in game and there's no XP, 0 means disabled.",
            position: 3,
            units: " mins",
            range: { min: 0, max: 2147483647 },
            default: 0,
        }),
        resetSkillRateAfter: ConfigItem({
            name: "Auto reset after",
            description:
                "Configures how many minutes passes before resetting a skill's per hour rates while in game and there's no XP, 0 means disabled.",
            position: 4,
            units: " mins",
            range: { min: 0, max: 2147483647 },
            default: 0,
        }),
        skillTabOverlayMenuOptions: ConfigItem({
            name: "Add skill tab canvas menu option",
            description:
                "Configures whether a menu option to show/hide canvas XP trackers will be added to skills on the skill tab.",
            position: 5,
            section: "overlay",
            default: true,
        }),
        onScreenDisplayMode: ConfigItem({
            name: "On-screen tracker display mode (top)",
            description: "Configures the information displayed in the first line of on-screen XP overlays.",
            position: 6,
            section: "overlay",
            enum: labelOptions,
            default: "XP_GAINED",
        }),
        onScreenDisplayModeBottom: ConfigItem({
            name: "On-screen tracker display mode (bottom)",
            description: "Configures the information displayed in the second line of on-screen XP overlays.",
            position: 7,
            section: "overlay",
            enum: labelOptions,
            default: "XP_HOUR",
        }),
        xpPanelLabel1: ConfigItem({
            name: "Top-left XP info label",
            description: "Configures the information displayed in the top-left of XP info box.",
            position: 8,
            enum: labelOptions,
            default: "XP_GAINED",
        }),
        xpPanelLabel2: ConfigItem({
            name: "Top-right XP info label",
            description: "Configures the information displayed in the top-right of XP info box.",
            position: 9,
            enum: labelOptions,
            default: "XP_LEFT",
        }),
        xpPanelLabel3: ConfigItem({
            name: "Bottom-left XP info label",
            description: "Configures the information displayed in the bottom-left of XP info box.",
            position: 10,
            enum: labelOptions,
            default: "XP_HOUR",
        }),
        xpPanelLabel4: ConfigItem({
            name: "Bottom-right XP info label",
            description: "Configures the information displayed in the bottom-right of XP info box.",
            position: 11,
            enum: labelOptions,
            default: "ACTIONS_LEFT",
        }),
        progressBarLabel: ConfigItem({
            name: "Progress bar label",
            description: "Configures the info box progress bar to show time to goal or percentage complete.",
            position: 12,
            enum: progressOptions,
            default: "PERCENTAGE",
        }),
        progressBarTooltipLabel: ConfigItem({
            name: "Tooltip label",
            description: "Configures the info box progress bar tooltip to show time to goal or percentage complete.",
            position: 13,
            enum: progressOptions,
            default: "TIME_TO_LEVEL",
        }),
        prioritizeRecentXpSkills: ConfigItem({
            name: "Move recently trained skills to top",
            description: "Configures whether skills should be organized by most recently gained XP.",
            position: 14,
            default: false,
        }),
    },
    {
        sections: {
            overlay: { name: "Overlay", position: 99 },
        },
    },
);
