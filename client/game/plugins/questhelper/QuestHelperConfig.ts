import { ConfigGroup, ConfigItem, ConfigSection } from "@runelite/client/config/ConfigItem";

/** Upstream enums: RuneLite stores and lists a constant by its name. */
const names = <T extends string>(...values: T[]): Record<T, T> =>
    Object.fromEntries(values.map((value) => [value, value])) as Record<T, T>;

export const NpcHighlightStyle = names("NONE", "OUTLINE", "CONVEX_HULL", "TILE");
export const ObjectHighlightStyle = names("NONE", "CLICK_BOX", "OUTLINE");
export const GroundItemHighlightStyle = names("NONE", "CLICK_BOX", "OUTLINE", "TILE");
export const InventoryItemHighlightStyle = names("NONE", "SQUARE", "OUTLINE", "FILLED_OUTLINE");
export const QuestOrdering = names(
    "A_TO_Z",
    "Z_TO_A",
    "OPTIMAL",
    "OPTIMAL_IRONMAN",
    "RELEASE_DATE",
    "QUEST_POINTS_ASC",
    "QUEST_POINTS_DESC",
);
/** QuestFilter.displayFilters(): OPTIMAL is internal to the optimal orders. */
export const QuestFilter = names(
    "SHOW_ALL",
    "SHOW_MEETS_REQS",
    "FREE_TO_PLAY",
    "MEMBERS",
    "QUEST",
    "MINIQUEST",
    "ACHIEVEMENT_DIARY",
    "GENERIC_HELPER",
    "SKILL_HELPER",
    "SKILL_FREE_TO_PLAY",
    "SKILL_MEMBERS",
    "PLAYER_MADE_QUESTS",
);
export const Difficulty = names(
    "ALL",
    "NOVICE",
    "INTERMEDIATE",
    "EXPERIENCED",
    "MASTER",
    "GRANDMASTER",
    "MINIQUEST",
    "ACHIEVEMENT_DIARY",
    "GENERIC",
    "SKILL",
    "PLAYER_QUEST",
);

/**
 * Quest Helper's QuestHelperConfig at 06da90f: group, keys, defaults, sections and order. Items
 * the offline client can't provide are listed in the README rather than shown as dead switches.
 */
export const QuestHelperConfig = ConfigGroup(
    "questhelper",
    {
        selectedQuest: ConfigItem({ name: "Selected quest", description: "Last selected quest key.", default: "", hidden: true }),
        helperVariant: ConfigItem({ name: "Quest variant", default: "", hidden: true }),
        autoStartQuests: ConfigItem({
            keyName: "autostartQuests",
            name: "Auto start helper",
            description: "Automatically start the quest helper when you start a quest",
            default: true,
        }),
        autoOpenSidebar: ConfigItem({
            name: "Auto open sidebar",
            description: "Automatically opens the quest helper sidebar when you start a quest",
            default: true,
        }),
        showOverlay: ConfigItem({
            keyName: "showOverlayPanel",
            name: "Display overlay on screen",
            description: "Chose whether the overlay should be displayed on screen",
            default: true,
        }),
        stewBoosts: ConfigItem({
            keyName: "stewBoostsPanel",
            name: "Use Spicy stew for boosts",
            description: "Raises the boost maximum boost for certain skills to 5",
            default: false,
        }),
        showFullRequirements: ConfigItem({
            name: "Show full quest requirements",
            description: "Show all quest requirements, including requirements for sub-quests",
            section: "sidebarDetailsSection",
            default: false,
        }),
        hideQuestRewards: ConfigItem({
            name: "Hide quest rewards",
            description: "Enable this config if you want to hide quest rewards.",
            section: "sidebarDetailsSection",
            default: false,
        }),
        showTextHighlight: ConfigItem({
            name: "Highlight correct dialog",
            description: "Highlight correct dialog choices",
            section: "hintsSection",
            default: true,
        }),
        showSymbolOverlay: ConfigItem({
            name: "Display icons on NPCs and objects",
            description: "Choose whether NPCs should have icons marking them as the current target or not",
            section: "hintsSection",
            default: true,
        }),
        highlightStyleNpcs: ConfigItem({
            name: "Highlight style NPCs",
            description: "Choose the highlight style of the target NPCs",
            section: "hintsSection",
            enum: NpcHighlightStyle,
            default: "OUTLINE",
        }),
        highlightStyleObjects: ConfigItem({
            name: "Highlight style objects",
            description: "Choose the highlight style of the target objects",
            section: "hintsSection",
            enum: ObjectHighlightStyle,
            default: "OUTLINE",
        }),
        highlightStyleGroundItems: ConfigItem({
            name: "Highlight style ground items",
            description: "Choose the highlight style of the target items",
            section: "hintsSection",
            enum: GroundItemHighlightStyle,
            default: "OUTLINE",
        }),
        highlightStyleInventoryItems: ConfigItem({
            name: "Highlight style inventory items",
            description: "Choose the highlight style of the target inventory items",
            section: "hintsSection",
            enum: InventoryItemHighlightStyle,
            default: "FILLED_OUTLINE",
        }),
        outlineThickness: ConfigItem({
            name: "Outline thickness",
            description: "Choose the thickness of target model outlines",
            section: "hintsSection",
            range: { min: 0, max: 50 },
            default: 4,
        }),
        outlineFeathering: ConfigItem({
            name: "Outline feathering",
            description: "Choose how the model outline is faded out",
            section: "hintsSection",
            range: { min: 0, max: 4 },
            default: 4,
        }),
        showMiniMapArrow: ConfigItem({
            name: "Display arrows on the mini-map and overworld",
            description: "Choose whether flashing arrows point to the next objective",
            section: "hintsSection",
            default: true,
        }),
        haveMinimapArrowFlash: ConfigItem({
            name: "Have the minimap arrow flash",
            description: "Choose whether the minimap direction arrow flashes",
            section: "hintsSection",
            default: true,
        }),
        showWorldLines: ConfigItem({
            name: "Display navigation paths",
            description: "Choose whether navigation paths are drawn to the next objective",
            section: "hintsSection",
            default: true,
        }),
        showWidgetHints: ConfigItem({
            name: "Display widget hints",
            description: "Choose whether important widget actions are highlighted",
            section: "hintsSection",
            default: true,
        }),
        solvePuzzles: ConfigItem({
            name: "Show Puzzle Solutions",
            description: "Shows the solutions to quest puzzles",
            section: "hintsSection",
            default: true,
        }),
        showWorldMapPoint: ConfigItem({
            name: "Display world map point",
            description: "Choose whether the arrow & icon of your current step should be visible on the world map.",
            section: "hintsSection",
            default: true,
        }),
        useShortestPath: ConfigItem({
            name: "Use 'Shortest Path' plugin",
            description: "If you have the 'Shortest Path' plugin downloaded, it will be used to show routes to locations",
            section: "hintsSection",
            default: false,
        }),
        textHighlightColor: ConfigItem({
            name: "Text highlight colour",
            description: "Change the colour of dialog choices highlighted by the helper",
            section: "colorSection",
            color: true,
            alpha: true,
            default: 0xff0000ff,
        }),
        targetOverlayColor: ConfigItem({
            name: "Color of target overlay",
            description: "Change the colour which target NPCs/Objects will be highlighted with",
            section: "colorSection",
            color: true,
            alpha: true,
            default: 0xff00ffff,
        }),
        passColour: ConfigItem({
            name: "Colour of passed requirements/checks",
            description: "Change the colour that will indicate a check has passed",
            section: "colorSection",
            color: true,
            alpha: true,
            default: 0xff00ff00,
        }),
        failColour: ConfigItem({
            name: "Colour of failed requirements/checks",
            description: "Change the colour that will indicate a check has failed",
            section: "colorSection",
            color: true,
            alpha: true,
            default: 0xffff0000,
        }),
        partialSuccessColour: ConfigItem({
            name: "Colour of partially passed requirements/checks",
            description: "Change the colour that will indicate a check has partially passed (such as item is in your bank)",
            section: "colorSection",
            color: true,
            alpha: true,
            default: 0xffffffff,
        }),
        boostColour: ConfigItem({
            name: "Colour of boostable skill",
            description: "Change the colour that will indicate a skill level check has passed",
            section: "colorSection",
            color: true,
            alpha: true,
            default: 0xffffc800,
        }),
        orderListBy: ConfigItem({
            name: "Quest order",
            description: "Configures which way to order the quest list",
            section: "filterSection",
            enum: QuestOrdering,
            default: "A_TO_Z",
        }),
        filterListBy: ConfigItem({
            name: "Filter",
            description: "Configures what to filter in the quest list",
            section: "filterSection",
            enum: QuestFilter,
            default: "SHOW_ALL",
        }),
        difficulty: ConfigItem({
            keyName: "questDifficulty",
            name: "Difficulty",
            description: "Configures what quest difficulty to show",
            section: "filterSection",
            enum: Difficulty,
            default: "ALL",
        }),
        showCompletedQuests: ConfigItem({
            name: "Show Completed Quests",
            description: "Will include completed quests in the other filter(s) that are chosen",
            section: "filterSection",
            default: false,
        }),
    },
    {
        sections: {
            sidebarDetailsSection: ConfigSection({ name: "Sidebar details", position: 1 }),
            hintsSection: ConfigSection({ name: "Quest Hints", position: 2 }),
            colorSection: ConfigSection({ name: "Colours", position: 3 }),
            filterSection: ConfigSection({ name: "Quest Filters", position: 4 }),
        },
    },
);

/** Settings the engine itself reads (puzzle solutions, hints, requirement colours). */
export const ENGINE_CONFIG_KEYS = [
    "solvePuzzles",
    "showWidgetHints",
    "showWorldLines",
    "stewBoosts",
    "showFullRequirements",
    "passColour",
    "failColour",
    "partialSuccessColour",
    "boostColour",
    "targetOverlayColor",
    "textHighlightColor",
    "useShortestPath",
] as const;

/** Keys the earlier port used, and the upstream keys that replaced them. */
export const LEGACY_CONFIG_KEYS: Readonly<Record<string, string>> = {
    highlightWidgets: "showWidgetHints",
    showOverlays: "solvePuzzles",
    showDirections: "showMiniMapArrow",
    highlightColor: "targetOverlayColor",
};
