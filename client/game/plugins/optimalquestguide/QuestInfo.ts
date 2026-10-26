/*
 * Copyright (c) 2020, Christopher Oswald <https://github.com/cesoun>
 * All rights reserved.
 *
 * Ported to TypeScript. BSD 2-Clause License, see ./LICENSE.
 */
import type { Client } from "@runelite/api/Client";
import type { QuestState } from "@runelite/api/QuestState";
import * as VarPlayerID from "@runelite/api/gameval/VarPlayerID";
import { SKILL_NAME, type SkillId } from "../../../rs/skill/skills";

/** One requirement from quests.json: a skill name, "Quest points" or "Combat level". */
export type QuestRequirement = {
    skill: string;
    level: number;
    boostable: boolean;
};

/** One quest from quests.json, in the guide's order. */
export type QuestData = {
    name: string;
    uri: string;
    reqs: QuestRequirement[];
};

/** A quest with its place in the guide and its state, once the plugin has read it. */
export type QuestInfo = QuestData & {
    index: number;
    questState?: QuestState;
};

/** One of the plugin's images in `public/optimalquestguide/` (credited in its LICENSE.md). */
export function guideImage(file: string): string {
    const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
    return `${base}/optimalquestguide/${file}`;
}

const QUEST_POINTS = "quest points";
const COMBAT_LEVEL = "combat level";

const SKILL_BY_NAME = new Map<string, SkillId>(
    Object.entries(SKILL_NAME).map(([id, name]) => [name.toLowerCase(), Number(id) as SkillId]),
);

/** The skill a requirement names (Java's `Skill.valueOf(skill.toUpperCase())`). */
export function requirementSkill(requirement: QuestRequirement): SkillId | undefined {
    return SKILL_BY_NAME.get(requirement.skill.toLowerCase());
}

/**
 * QuestRequirement.getIcon: the plugin's quest point and combat icons, RuneLite's small skill
 * icons for the rest.
 */
export function requirementIcon(requirement: QuestRequirement): string | undefined {
    const skill = requirement.skill.toLowerCase();
    if (skill === QUEST_POINTS) return guideImage("quest_point.png");
    if (skill === COMBAT_LEVEL) return guideImage("combat_level.png");
    const id = requirementSkill(requirement);
    return id === undefined ? undefined : guideImage(`skill_icons_small/${skill}.png`);
}

/**
 * The player's level for a requirement: quest points, combat level, or the real skill level.
 * Undefined with no local player (QuestPanel.update skips the requirement then).
 */
export function playerLevel(client: Client, requirement: QuestRequirement): number | undefined {
    const player = client.getLocalPlayer();
    if (!player) return undefined;
    const skill = requirement.skill.toLowerCase();
    if (skill === QUEST_POINTS) return client.getVarpValue(VarPlayerID.QP);
    if (skill === COMBAT_LEVEL) return player.getCombatLevel();
    const id = requirementSkill(requirement);
    return id === undefined ? undefined : client.getRealSkillLevel(id);
}

/** The guide's quests from quests.json, numbered in order (GuidePlugin.startUp). */
export function loadQuestInfos(data: readonly QuestData[]): QuestInfo[] {
    return data.map((quest, index) => ({ ...quest, index }));
}
