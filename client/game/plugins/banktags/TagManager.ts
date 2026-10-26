import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import { mapVariation } from "@runelite/client/game/ItemVariationMapping";
import type { BankTag } from "./BankTagsService";
import { fromCSV, standardize, toCSV } from "./bankTagText";

export const CONFIG_GROUP = "banktags";
export const ITEM_KEY_PREFIX = "item_";
export const TAG_HIDDEN_PREFIX = "hidden_";

/**
 * RuneLite's TagManager. An item's tags are stored as `banktags.item_<id>`: a CSV of tag names.
 * The id is the canonical item (a noted item or placeholder counts as its item). A variation tag
 * (shown with a trailing `*`) is stored under the negated base id of the item's variation group,
 * so it covers every variation.
 */
export class TagManager {
    private readonly customTags = new Map<string, BankTag>();

    constructor(
        private readonly configManager: ConfigManager,
        private readonly canonicalize: (itemId: number) => number,
    ) {}

    getTagString(itemId: number, variation: boolean): string {
        return this.configManager.getConfiguration(CONFIG_GROUP, ITEM_KEY_PREFIX + this.getItemId(itemId, variation)) ?? "";
    }

    /** The item's tags, lower case, in stored order. */
    getTags(itemId: number, variation: boolean): Set<string> {
        return new Set(fromCSV(this.getTagString(itemId, variation).toLowerCase()));
    }

    setTagString(itemId: number, tags: string, variation: boolean): void {
        const key = ITEM_KEY_PREFIX + this.getItemId(itemId, variation);
        if (!tags) this.configManager.unsetConfiguration(CONFIG_GROUP, key);
        else this.configManager.setConfiguration(CONFIG_GROUP, key, tags);
    }

    addTags(itemId: number, add: Iterable<string>, variation: boolean): void {
        const tags = this.getTags(itemId, variation);
        const before = tags.size;
        for (const tag of add) tags.add(tag);
        if (tags.size !== before) this.setTags(itemId, tags, variation);
    }

    addTag(itemId: number, tag: string, variation: boolean): void {
        const tags = this.getTags(itemId, variation);
        const before = tags.size;
        tags.add(standardize(tag));
        if (tags.size !== before) this.setTags(itemId, tags, variation);
    }

    private setTags(itemId: number, tags: Iterable<string>, variation: boolean): void {
        this.setTagString(itemId, toCSV(tags), variation);
    }

    /** Whether one of the item's tags (or variation tags) starts with `search`. */
    findTag(itemId: number, search: string): boolean {
        const prefix = standardize(search);
        for (const tag of this.allTags(itemId)) if (tag.startsWith(prefix)) return true;
        return false;
    }

    /** Every stored id (negative for a variation tag) carrying exactly `tag`. */
    getItemsForTag(tag: string): number[] {
        const prefix = `${CONFIG_GROUP}.${ITEM_KEY_PREFIX}`;
        return this.configManager
            .getConfigurationKeys(prefix)
            .map((key) => parseInt(key.slice(prefix.length), 10))
            .filter((id) => Number.isFinite(id) && (this.getTags(id, false).has(tag) || this.getTags(id, true).has(tag)));
    }

    /** Removes `tag` from every item, and its hidden flag. */
    removeTag(tag: string): void;
    /** Removes `tag` from one item, both as a tag and a variation tag. */
    removeTag(itemId: number, tag: string): void;
    removeTag(a: string | number, b?: string): void {
        if (typeof a === "string") {
            const prefix = `${CONFIG_GROUP}.${ITEM_KEY_PREFIX}`;
            for (const key of this.configManager.getConfigurationKeys(prefix)) {
                const id = parseInt(key.slice(prefix.length), 10);
                if (Number.isFinite(id)) this.removeTag(id, a);
            }
            this.setHidden(a, false);
            return;
        }
        const tag = standardize(b!);
        for (const variation of [false, true]) {
            const tags = this.getTags(a, variation);
            if (tags.delete(tag)) this.setTags(a, tags, variation);
        }
    }

    renameTag(oldTag: string, newTag: string): void {
        for (const id of this.getItemsForTag(standardize(oldTag))) {
            const tags = this.getTags(id, id < 0);
            tags.delete(standardize(oldTag));
            tags.add(standardize(newTag));
            this.setTags(id, tags, id < 0);
        }
    }

    isHidden(tag: string): boolean {
        return this.configManager.getConfiguration(CONFIG_GROUP, TAG_HIDDEN_PREFIX + standardize(tag)) === "true";
    }

    setHidden(tag: string, hidden: boolean): void {
        const key = TAG_HIDDEN_PREFIX + standardize(tag);
        if (hidden) this.configManager.setConfiguration(CONFIG_GROUP, key, true);
        else this.configManager.unsetConfiguration(CONFIG_GROUP, key);
    }

    registerTag(name: string, tag: BankTag): void {
        this.customTags.set(name, tag);
    }

    unregisterTag(name: string): void {
        this.customTags.delete(name);
    }

    findCustomTag(name: string): BankTag | undefined {
        return this.customTags.get(name);
    }

    private allTags(itemId: number): Set<string> {
        const tags = this.getTags(itemId, false);
        for (const tag of this.getTags(itemId, true)) tags.add(tag);
        return tags;
    }

    private getItemId(itemId: number, variation: boolean): number {
        const id = this.canonicalize(Math.abs(itemId));
        return variation ? -mapVariation(id) : id;
    }
}
