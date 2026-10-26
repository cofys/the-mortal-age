/*
 * Copyright (c) 2020, Christopher Oswald <https://github.com/cesoun>
 * All rights reserved.
 *
 * Ported to TypeScript. BSD 2-Clause License, see ./LICENSE.
 */
import { ConfigGroup, ConfigItem, ConfigSection } from "@runelite/client/config/ConfigItem";

/** Optimal Quest Guide's GuideConfig: group, keys, defaults and order as in the plugin. */
export const GuideConfig = ConfigGroup(
    "optimal-quest-guide",
    {
        showCompletedQuests: ConfigItem({
            name: "Show completed quests",
            description: "Displays already completed quests",
            default: false,
        }),
        searchCompletedQuests: ConfigItem({
            name: "Search completed quests",
            description: "Have the search include completed quests",
            default: false,
        }),
        filterMetRequirements: ConfigItem({
            name: "Filter by met Requirements",
            description: "Only display the quests that you have the met requirements to complete",
            default: false,
        }),
        getInProgressColor: ConfigItem({
            keyName: "inProgressColor",
            name: "Quest in progress color",
            description: "Color of Quests in progress",
            section: "questStatusSection",
            color: true,
            default: 0xf0cf7b,
        }),
        getCompletedColor: ConfigItem({
            keyName: "completedColor",
            name: "Quest completed color",
            description: "Color of Quests that have been completed",
            section: "questStatusSection",
            color: true,
            default: 0x6ee16e,
        }),
        getNotStartedColor: ConfigItem({
            keyName: "notStartedColor",
            name: "Quest not started color",
            description: "Color of Quests that have not been started",
            section: "questStatusSection",
            color: true,
            default: 0xc6c6c6,
        }),
        getRequirementMetColor: ConfigItem({
            keyName: "requirementMetColor",
            name: "Requirement level met",
            description: "Color of Requirements that have been met or exceeded",
            section: "questRequirementSection",
            color: true,
            default: 0x6ee16e,
        }),
        getRequirementUnmetColor: ConfigItem({
            keyName: "requirementUnmetColor",
            name: "Requirement level unmet",
            description: "Color of Requirements that have been unmet and unboostable",
            section: "questRequirementSection",
            color: true,
            default: 0xe61e1e,
        }),
        getRequirementBoostableColor: ConfigItem({
            keyName: "requirementBoostableColor",
            name: "Requirement boostable",
            description: "Color of Requirements that have are unmet and boostable",
            section: "questRequirementSection",
            color: true,
            default: 0x32a0fa,
        }),
    },
    {
        sections: {
            questStatusSection: ConfigSection({
                name: "Quest Status Colors",
                position: 98,
            }),
            questRequirementSection: ConfigSection({
                name: "Quest Requirement Colors",
                position: 99,
            }),
        },
    },
);
