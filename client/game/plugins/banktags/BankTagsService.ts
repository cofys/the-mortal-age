import type { Layout } from "./tabs/Layout";

/**
 * A bank tag. Plugins may implement this to define custom bank tags, and register one with
 * TagManager.registerTag to make it searchable in the bank and the tab interface.
 */
export interface BankTag {
    /** Whether an item is in the tag. */
    contains(itemId: number): boolean;
}

/** RuneLite's BankTagsService option flags. */
export const OPTION_ALLOW_MODIFICATIONS = 0x1;
/** Hide the tag name. */
export const OPTION_HIDE_TAG_NAME = 0x2;
/** Stop openBankTag from applying a layout. */
export const OPTION_NO_LAYOUT = 0x4;
/** Put items that are in the bank but not in the layout at the bottom. */
export const OPTION_ITEMS_NOT_IN_LAYOUT_AT_BOTTOM = 0x8;

/** RuneLite's BankTagsService: the bank tags plugin's API for other plugins. */
export interface BankTagsService {
    /**
     * Open the given bank tag. The tag may have a tag tab, but needn't. If it has a layout, the
     * layout is applied.
     */
    openBankTag(tag: string, options: number): void;
    /** Close the open bank tag. */
    closeBankTag(): void;
    getActiveTag(): string | null;
    getActiveBankTag(): BankTag | null;
    getActiveLayout(): Layout | null;
}
