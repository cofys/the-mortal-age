import type { HelperQuest } from "./QuestHelperProtocol";

/** QuestOrders.normalizeQuestName: "a", "the" and "an" are ignored when sorting by name. */
export const normalizeQuestName = (name: string): string => name.replace(/\b(a|the|an)\b/gi, "").trim();

/** QuestDetails.Type of a catalog row; the native Tutorial Island route is a free quest. */
const typeOf = (quest: HelperQuest): string => quest.questType ?? "F2P";

/** QuestHelperConfig.QuestFilter predicates. */
const FILTERS: Readonly<Record<string, { title: string; test: (q: HelperQuest) => boolean }>> = {
    SHOW_ALL: { title: "Show all", test: () => true },
    SHOW_MEETS_REQS: { title: "Show meets reqs", test: (q) => q.eligibility?.known === true && q.eligibility.eligible },
    OPTIMAL: { title: "Optimal ordering", test: (q) => ["P2P", "F2P", "MINIQUEST", "ACHIEVEMENT_DIARY"].includes(typeOf(q)) },
    FREE_TO_PLAY: { title: "Free to play", test: (q) => typeOf(q) === "F2P" },
    MEMBERS: { title: "Members", test: (q) => typeOf(q) === "P2P" },
    QUEST: { title: "Quests", test: (q) => ["P2P", "F2P"].includes(typeOf(q)) },
    MINIQUEST: { title: "Miniquests", test: (q) => typeOf(q) === "MINIQUEST" },
    ACHIEVEMENT_DIARY: { title: "Achievement diaries", test: (q) => typeOf(q) === "ACHIEVEMENT_DIARY" },
    GENERIC_HELPER: { title: "Generic helpers", test: (q) => typeOf(q) === "GENERIC" },
    SKILL_HELPER: { title: "Skill helpers", test: (q) => ["SKILL_P2P", "SKILL_F2P"].includes(typeOf(q)) },
    SKILL_FREE_TO_PLAY: { title: "Skill free to play", test: (q) => typeOf(q) === "SKILL_F2P" },
    SKILL_MEMBERS: { title: "Skill members", test: (q) => typeOf(q) === "SKILL_P2P" },
    PLAYER_MADE_QUESTS: { title: "Player-made quests", test: (q) => typeOf(q) === "PLAYER_QUEST" },
};

export const filterTitle = (filter: string): string => FILTERS[filter]?.title ?? filter;

const byName = (a: HelperQuest, b: HelperQuest) => normalizeQuestName(a.name).localeCompare(normalizeQuestName(b.name));
/** Comparator.comparing(indexOf): an unlisted quest (-1) sorts first, as upstream's does. */
const byIndex = (key: "optimalOrder" | "ironmanOrder" | "releaseOrder") => (a: HelperQuest, b: HelperQuest) => (a[key] ?? -1) - (b[key] ?? -1);
const byPoints = (a: HelperQuest, b: HelperQuest) => (a.questPoints ?? 0) - (b.questPoints ?? 0);

/** QuestHelperConfig.QuestOrdering: each order's comparator and the sections it lists. */
const ORDERINGS: Readonly<Record<string, { compare: (a: HelperQuest, b: HelperQuest) => number; sections: string[] }>> = {
    A_TO_Z: { compare: byName, sections: ["QUEST", "MINIQUEST", "ACHIEVEMENT_DIARY", "SKILL_HELPER", "GENERIC_HELPER", "PLAYER_MADE_QUESTS"] },
    Z_TO_A: { compare: (a, b) => byName(b, a), sections: ["QUEST", "MINIQUEST", "ACHIEVEMENT_DIARY", "SKILL_HELPER", "GENERIC_HELPER", "PLAYER_MADE_QUESTS"] },
    OPTIMAL: { compare: byIndex("optimalOrder"), sections: ["OPTIMAL", "GENERIC_HELPER"] },
    OPTIMAL_IRONMAN: { compare: byIndex("ironmanOrder"), sections: ["OPTIMAL", "GENERIC_HELPER"] },
    RELEASE_DATE: { compare: byIndex("releaseOrder"), sections: ["QUEST", "MINIQUEST"] },
    QUEST_POINTS_ASC: { compare: byPoints, sections: ["QUEST"] },
    QUEST_POINTS_DESC: { compare: (a, b) => byPoints(b, a), sections: ["QUEST"] },
};

export type QuestListOptions = {
    orderListBy: string;
    filterListBy: string;
    difficulty: string;
    showCompletedQuests: boolean;
    /** Skills whose quests are hidden (the skill filter buttons). */
    filteredSkills?: ReadonlySet<string>;
    search?: string;
    label?: (quest: HelperQuest) => string;
};

/**
 * SkillFiltering.passesSkillFilter: the quest, and every quest it requires, neither requires
 * nor gives experience in a filtered skill.
 */
export function passesSkillFilter(quest: HelperQuest, quests: readonly HelperQuest[], skills: ReadonlySet<string>, seen = new Set<string>()): boolean {
    if (!skills.size) return true;
    if (seen.has(quest.name)) return true;
    seen.add(quest.name);
    if ((quest.filterSkills ?? []).some((skill) => skills.has(skill))) return false;
    return (quest.requiredQuests ?? []).every((name) => {
        const required = quests.find((q) => q.name === name);
        return !required || passesSkillFilter(required, quests, skills, seen);
    });
}

/**
 * QuestHelperPanel.refresh: the catalog filtered by the filter, difficulty, completion and
 * skill filters, sorted by the ordering, and grouped into the ordering's sections. A search
 * matches the quest's name (keywords are not exported) and ignores the sections.
 */
export function questListSections(quests: readonly HelperQuest[], options: QuestListOptions): { title: string; quests: HelperQuest[] }[] {
    const ordering = ORDERINGS[options.orderListBy] ?? ORDERINGS.A_TO_Z;
    const filter = FILTERS[options.filterListBy] ?? FILTERS.SHOW_ALL;
    const skills = options.filteredSkills ?? new Set<string>();
    const visible = quests
        .filter((q) => filter.test(q))
        .filter((q) => options.difficulty === "ALL" || !q.difficulty || q.difficulty === options.difficulty)
        .filter((q) => options.showCompletedQuests || q.status !== "FINISHED")
        .filter((q) => passesSkillFilter(q, quests, skills))
        .sort((a, b) => ordering.compare(a, b) || byName(a, b));
    const search = options.search?.trim().toLowerCase();
    if (search) {
        const label = options.label ?? ((q: HelperQuest) => q.name);
        const terms = search.split(/\s+/);
        return [{ title: "", quests: visible.filter((q) => terms.every((term) => label(q).toLowerCase().includes(term))) }];
    }
    return ordering.sections
        .map((section) => ({ title: FILTERS[section].title, quests: visible.filter(FILTERS[section].test) }))
        .filter((section) => section.quests.length > 0);
}

/** AssistanceLevel: the settings each preset writes. */
export const ASSISTANCE_LEVELS = {
    minimum: {
        autoStartQuests: true, autoOpenSidebar: true, showOverlay: false, showTextHighlight: false, showSymbolOverlay: false,
        highlightStyleNpcs: "NONE", highlightStyleObjects: "NONE", highlightStyleGroundItems: "NONE", highlightStyleInventoryItems: "NONE",
        showMiniMapArrow: false, showWorldLines: false, showWidgetHints: false, solvePuzzles: false,
    },
    medium: {
        autoStartQuests: true, autoOpenSidebar: true, showOverlay: true, showTextHighlight: true, showSymbolOverlay: false,
        highlightStyleNpcs: "NONE", highlightStyleObjects: "NONE", highlightStyleGroundItems: "NONE", highlightStyleInventoryItems: "NONE",
        showMiniMapArrow: true, showWorldLines: true, showWidgetHints: false, solvePuzzles: false,
    },
    full: {
        autoStartQuests: true, autoOpenSidebar: true, showOverlay: true, showTextHighlight: true, showSymbolOverlay: true,
        highlightStyleNpcs: "OUTLINE", highlightStyleObjects: "OUTLINE", highlightStyleGroundItems: "OUTLINE", highlightStyleInventoryItems: "OUTLINE",
        showMiniMapArrow: true, showWorldLines: true, showWidgetHints: true, solvePuzzles: true,
    },
} as const;
export type AssistanceLevel = keyof typeof ASSISTANCE_LEVELS;

/** Skill.values() as the skill filter lists them, by RuneLite Skill name. */
export const FILTER_SKILLS = [
    "Attack", "Strength", "Defence", "Ranged", "Prayer", "Magic", "Runecraft", "Construction", "Hitpoints", "Agility", "Herblore", "Thieving",
    "Crafting", "Fletching", "Slayer", "Hunter", "Mining", "Smithing", "Fishing", "Cooking", "Firemaking", "Woodcutting", "Farming", "Sailing",
] as const;
