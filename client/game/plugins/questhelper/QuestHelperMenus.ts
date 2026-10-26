import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { HelperQuest } from "./QuestHelperProtocol";

/** The quest tab's quest list (QuestWidgets.QUEST_CONTAINER, 399:7); its rows are its children. */
export const QUEST_LIST_GROUP = 399;
export const QUEST_LIST_UID = (QUEST_LIST_GROUP << 16) | 7;

/** Readable names of the helper variants a quest splits into (QuestHelperQuest names). */
export const variantLabels: Readonly<Record<string, string>> = {
    SHIELD_OF_ARRAV_PHOENIX_GANG: "Phoenix Gang",
    SHIELD_OF_ARRAV_BLACK_ARM_GANG: "Black Arm Gang",
    RECIPE_FOR_DISASTER_START: "Start",
    RECIPE_FOR_DISASTER_DWARF: "Mountain Dwarf",
    RECIPE_FOR_DISASTER_WARTFACE_AND_BENTNOZE: "Wartface and Bentnoze",
    RECIPE_FOR_DISASTER_PIRATE_PETE: "Pirate Pete",
    RECIPE_FOR_DISASTER_LUMBRIDGE_GUIDE: "Lumbridge Guide",
    RECIPE_FOR_DISASTER_EVIL_DAVE: "Evil Dave",
    RECIPE_FOR_DISASTER_MONKEY_AMBASSADOR: "King Awowogei",
    RECIPE_FOR_DISASTER_SIR_AMIK_VARZE: "Sir Amik Varze",
    RECIPE_FOR_DISASTER_SKRACH_UGLOGWEE: "Skrach Uglogwee",
    RECIPE_FOR_DISASTER_FINALE: "Final battle",
};

export function questLabel(quest: HelperQuest, quests: readonly HelperQuest[]): string {
    const branch = quest.helperVariant && variantLabels[quest.helperVariant];
    return branch && quests.filter((other) => other.questKey === quest.questKey).length > 1 ? `${quest.name} — ${branch}` : quest.name;
}

const stripTags = (text: string | undefined) => (text ?? "").replace(/<[^>]*>/g, "").trim();

/**
 * QuestMenuHandler.handleQuestList: under a quest's "Read journal:" entry, "Start Quest Helper"
 * (or "Stop Quest Helper" for the guide in use) for each unfinished helper route of that quest,
 * so Shield of Arrav offers each gang and Recipe for Disaster each subquest.
 */
export function questListMenuEntries(
    entries: SimpleMenuEntry[],
    quests: readonly HelperQuest[],
    selected: string,
    selectedVariant: string | undefined,
    select: (questKey: string, variant?: string) => void,
): SimpleMenuEntry[] {
    const index = entries.findIndex((entry) => entry.option === "Read journal:");
    if (index < 0) return entries;
    const name = stripTags(entries[index].target);
    const routes = quests.filter((quest) => quest.supported && quest.name === name);
    if (!routes.length || routes.every((quest) => quest.status === "FINISHED")) return entries;
    const added: SimpleMenuEntry[] = [];
    const active = routes.find((quest) => quest.questKey === selected && (!selectedVariant || quest.helperVariant === selectedVariant));
    // RFDStart in use, or a gang chosen, lists only that route's Stop entry, as upstream does.
    const offered = active && (active.helperVariant?.startsWith("SHIELD_OF_ARRAV") || active.helperVariant === "RECIPE_FOR_DISASTER_START") ? [active] : routes;
    for (const quest of offered) {
        const isActive = quest === active;
        added.push({
            option: `${isActive ? "Stop" : "Start"} Quest Helper`,
            target: `<col=ff9040>${questLabel(quest, quests)}</col>`,
            onClick: () => (isActive ? select("") : select(quest.questKey, quest.helperVariant)),
        });
    }
    const out = entries.slice();
    out.splice(index + 1, 0, ...added);
    return out;
}
