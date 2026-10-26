import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";

/**
 * Where RuneLite adds its bank item options: just above "Examine". This client keeps widget ops
 * 1-10 only, so the bank's op 11 "Examine" is missing; the options then go where it would be,
 * last before "Cancel".
 */
export function examineSlot(entries: readonly SimpleMenuEntry[]): number {
    const examine = entries.findIndex((e) => e.option === "Examine");
    if (examine >= 0) return examine;
    const cancel = entries.findIndex((e) => e.option === "Cancel");
    return cancel >= 0 ? cancel : entries.length;
}

/** The item's menu target (its orange name), from the menu's other entries. */
export function itemTarget(entries: readonly SimpleMenuEntry[]): string {
    return entries.find((e) => e.option !== "Cancel" && e.target)?.target ?? "";
}

/**
 * Whether the menu is a bank item's own (RuneLite adds its options as the item's "Examine" is
 * added). Without the missing Examine, a withdraw op or a Jagex placeholder's "Release" marks it;
 * a layout placeholder has neither.
 */
export function isBankItemMenu(entries: readonly SimpleMenuEntry[]): boolean {
    return entries.some((e) => e.option === "Examine" || e.option === "Release" || e.option.startsWith("Withdraw-"));
}
