import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import { CONFIG_GROUP } from "../TagManager";
import { fromCSV, standardize, toCSV } from "../bankTagText";

export const TAG_TABS_CONFIG = "tagtabs";
export const TAG_ICON_PREFIX = "icon_";
/** ItemID.SPADE: a new tab's icon. */
const DEFAULT_ICON = 952;

/** RuneLite's TagTab: one of the tabs on the left of the bank. */
export class TagTab {
    constructor(
        public iconItemId: number,
        public tag: string,
    ) {}
}

/**
 * RuneLite's TabManager. The tab order is `banktags.tagtabs` (a CSV of tag names) and each tab's
 * icon is `banktags.icon_<tag>`.
 */
export class TabManager {
    readonly tabs: TagTab[] = [];

    constructor(private readonly configManager: ConfigManager) {}

    add(tagTab: TagTab): void {
        if (!this.contains(tagTab.tag)) this.tabs.push(tagTab);
    }

    clear(): void {
        this.tabs.length = 0;
    }

    find(tag: string): TagTab | undefined {
        const name = standardize(tag);
        return this.tabs.find((t) => t.tag === name);
    }

    loadAllTabNames(): string[] {
        return fromCSV(this.configManager.getConfiguration(CONFIG_GROUP, TAG_TABS_CONFIG) ?? "");
    }

    load(tag: string): TagTab {
        const found = this.find(tag);
        if (found) return found;
        const name = standardize(tag);
        const icon = parseInt(this.configManager.getConfiguration(CONFIG_GROUP, TAG_ICON_PREFIX + name) ?? "", 10);
        return new TagTab(Number.isFinite(icon) ? icon : DEFAULT_ICON, name);
    }

    swap(tagToMove: string, tagDestination: string): void {
        const from = standardize(tagToMove);
        const to = standardize(tagDestination);
        if (!this.contains(from) || !this.contains(to)) return;
        const a = this.indexOf(from);
        const b = this.indexOf(to);
        [this.tabs[a], this.tabs[b]] = [this.tabs[b], this.tabs[a]];
    }

    insert(tagToMove: string, tagDestination: string): void {
        const from = standardize(tagToMove);
        const to = standardize(tagDestination);
        if (!this.contains(from) || !this.contains(to)) return;
        // RuneLite's tabs.add(indexOf(to), tabs.remove(indexOf(from))): the index is taken first.
        const at = this.indexOf(to);
        const [moved] = this.tabs.splice(this.indexOf(from), 1);
        this.tabs.splice(at, 0, moved);
    }

    remove(tag: string): void {
        const tab = this.find(tag);
        if (!tab) return;
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        this.configManager.unsetConfiguration(CONFIG_GROUP, TAG_ICON_PREFIX + standardize(tag));
    }

    save(): void {
        this.configManager.setConfiguration(CONFIG_GROUP, TAG_TABS_CONFIG, toCSV(this.tabs.map((t) => t.tag)));
        for (const tab of this.tabs) {
            this.configManager.setConfiguration(CONFIG_GROUP, TAG_ICON_PREFIX + standardize(tab.tag), tab.iconItemId);
        }
    }

    size(): number {
        return this.tabs.length;
    }

    private contains(tag: string): boolean {
        return this.tabs.some((t) => t.tag === tag);
    }

    private indexOf(tag: string): number {
        const tab = this.find(tag);
        return tab ? this.tabs.indexOf(tab) : -1;
    }
}
