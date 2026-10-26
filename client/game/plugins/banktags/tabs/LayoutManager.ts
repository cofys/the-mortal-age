import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import type { ChatboxPanelManager } from "@runelite/client/game/chatbox/ChatboxPanelManager";
import { getVariations, mapVariation } from "@runelite/client/game/ItemVariationMapping";
import { BANK, INV, WORN } from "@runelite/api/gameval/InventoryID";
import { BANK_SCROLLPOS } from "@runelite/api/gameval/VarClientID";
import {
    BANK_BANKOPS_TOGGLE_ON,
    BANK_INSERTMODE,
    BANK_LEAVEPLACEHOLDERS,
    BANK_QUANTITY_TYPE,
    BANK_REQUESTEDQUANTITY,
    RUNE_POUCH_TYPE_1,
    RUNE_POUCH_TYPE_2,
    RUNE_POUCH_TYPE_3,
    RUNE_POUCH_TYPE_4,
} from "@runelite/api/gameval/VarbitID";
import { DIZANAS_QUIVER_TEMP_AMMO } from "@runelite/api/gameval/VarPlayerID";
import { BANK_FILLER, BH_RUNE_POUCH, BLANKOBJECT, DIVINE_RUNE_POUCH } from "@runelite/api/gameval/ItemID";
import { ScriptArgMagic } from "../../../../rs/cs2/Cs2Vm";
import type { Inventory } from "../../../../rs/inventory/Inventory";
import type { SimpleMenuEntry } from "../../../../ui/menu/MenuEngine";
import type { WidgetNode } from "../../../../widgets/WidgetNode";
import type { WidgetActionEvent } from "../../../widgets/widgetActionPayload";
import type { BankTagsClient } from "../bankClient";
import {
    BANK_ITEM_HEIGHT,
    BANK_ITEM_START_X,
    BANK_ITEM_WIDTH,
    BANK_ITEM_X_PADDING,
    BANK_ITEM_Y_PADDING,
    BANK_ITEMS_PER_ROW,
    Bankmain,
    ENUM_RUNEPOUCH_RUNE,
    EquipmentSlot,
    PARAM_BANK_AUTOCHARGE,
    PARAM_QUIVER_AMMO_AVAILABLE,
    ScriptID,
} from "../bankmain";
import { BankWidgets, ItemQuantityMode } from "../bankWidgets";
import type { BankSearch } from "../BankSearch";
import { type BankTag, OPTION_ALLOW_MODIFICATIONS, OPTION_ITEMS_NOT_IN_LAYOUT_AT_BOTTOM } from "../BankTagsService";
import { fromCSV, standardize } from "../bankTagText";
import { CONFIG_GROUP } from "../TagManager";
import { type AutoLayout, Layout } from "./Layout";
import { type BankMenuContext, DISABLE_LAYOUT, DUPLICATE_ITEM, REMOVE_LAYOUT, type TabInterface } from "./TabInterface";

export const TAG_LAYOUT_PREFIX = "layout_";

/** What the layout manager reads of the plugin. */
export interface LayoutManagerPlugin {
    getActiveBankTag(): BankTag | null;
    getActiveLayout(): Layout | null;
    getOptions(): number;
    openTag(tag: string | null, layout: Layout | null, options?: number): void;
}

type PluginAutoLayout = { owner: unknown; name: string; autoLayout: AutoLayout };
type ItemMatcher = (bank: Set<number>, itemId: number) => number;

/**
 * RuneLite's LayoutManager. A tab's layout is `banktags.layout_<tag>`: a CSV of item ids, one per
 * bank slot, -1 for an empty slot. A laid-out tab draws the bank's matching items at those
 * slots, placeholders where the item is missing, and lets them be dragged around without
 * moving them in the bank.
 *
 * Potion storage isn't here: the offline server has none, so RuneLite's PotionStorage (and its
 * matcher and withdraw handling) aren't ported.
 */
export class LayoutManager {
    private readonly autoLayouts: PluginAutoLayout[] = [];

    constructor(
        private readonly client: BankTagsClient,
        private readonly widgets: BankWidgets,
        private readonly plugin: LayoutManagerPlugin,
        private readonly configManager: ConfigManager,
        private readonly chatbox: ChatboxPanelManager,
        private readonly bankSearch: BankSearch,
    ) {
        this.registerAutoLayout(plugin, "Default", { generateLayout: (previous) => this.defaultLayout(previous) });
    }

    loadLayout(tag: string): Layout | null {
        const layoutStr = this.configManager.getConfiguration(CONFIG_GROUP, TAG_LAYOUT_PREFIX + standardize(tag));
        if (layoutStr === undefined) return null;
        return new Layout(tag, fromCSV(layoutStr).map((s) => parseInt(s, 10)));
    }

    saveLayout(layout: Layout): void {
        this.configManager.setConfiguration(CONFIG_GROUP, TAG_LAYOUT_PREFIX + standardize(layout.tag), layout.getLayout().join(","));
    }

    removeLayout(tag: string): void {
        this.configManager.unsetConfiguration(CONFIG_GROUP, TAG_LAYOUT_PREFIX + standardize(tag));
    }

    registerAutoLayout(owner: unknown, name: string, autoLayout: AutoLayout): void {
        if (this.autoLayouts.some((a) => a.name === name)) throw new Error(`Auto layout ${name} is already registered`);
        this.autoLayouts.push({ owner, name, autoLayout });
    }

    unregisterAutoLayout(name: string): void {
        const i = this.autoLayouts.findIndex((a) => a.name === name);
        if (i >= 0) this.autoLayouts.splice(i, 1);
    }

    // ------------------------------------------------------------------ layout

    onScriptPreFired(scriptId: number): void {
        if (scriptId !== ScriptID.BANKMAIN_FINISHBUILDING) return;
        this.resetWidgets();
        if (this.plugin.getActiveBankTag() === null) return;
        const layout = this.plugin.getActiveLayout();
        if (layout) {
            this.layout(layout);
            this.scrollLayout(layout);
        }
    }

    /** Layouts resize the bank's item children, which the bank only sizes when it opens. */
    private resetWidgets(): void {
        for (const c of this.widgets.children(this.client.getWidget(Bankmain.ITEMS))) {
            if (!c) continue;
            if ((c.rawHeight ?? 0) < BANK_ITEM_HEIGHT) break;
            if (c.rawWidth !== BANK_ITEM_WIDTH || c.rawHeight !== BANK_ITEM_HEIGHT) {
                this.widgets.setOriginalWidth(c, BANK_ITEM_WIDTH);
                this.widgets.setOriginalHeight(c, BANK_ITEM_HEIGHT);
                this.widgets.revalidate(c);
            }
        }
    }

    layout(l: Layout): void {
        const bank = this.client.getItemContainer(BANK);
        const itemContainer = this.client.getWidget(Bankmain.ITEMS);
        if (!bank || !itemContainer) return;

        // Hide the bank's items first.
        const bankItems = new Set<number>();
        for (let i = 0; i < bank.capacity; ++i) {
            const c = this.widgets.child(itemContainer, i);
            // ~bankmain_drawitem uses 6512 for empty slots.
            if (c && !this.widgets.isSelfHidden(c) && (c.itemId ?? -1) > -1 && c.itemId !== BLANKOBJECT) {
                bankItems.add(c.itemId!);
                this.widgets.setHidden(c, true);
            }
        }

        // Match each layout item 1:1 with a bank item, by the matchers in order of preference.
        // Unmatched layout items become placeholders; unmatched bank items join the layout.
        const layout = l.getLayout();
        const matchers: ItemMatcher[] = [
            (b, id) => (b.has(id) ? id : -1),
            (b, id) => this.matchPlaceholder(b, id),
            (b, id) => this.matchesVariant(b, id),
        ];
        const layoutToBank = new Map<number, number>();
        for (const matcher of matchers) {
            for (const itemId of layout) {
                if (itemId === -1 || layoutToBank.has(itemId)) continue;
                const matchedId = matcher(bankItems, itemId);
                if (matchedId === -1) continue;
                layoutToBank.set(itemId, matchedId);
                bankItems.delete(matchedId);
                // An item with objvars can be in the bank with its placeholder: drop both, so the
                // placeholder isn't added later as an untagged item.
                const placeholder = this.client.getItemDefinition(matchedId)?.placeholder ?? -1;
                bankItems.delete(placeholder);
            }
        }

        // The layout's items.
        layout.forEach((itemId, pos) => {
            if (itemId === -1) return;
            // A layout item with no matching bank item is drawn as itself (a placeholder).
            const bankItemId = layoutToBank.get(itemId) ?? itemId;
            const c = this.widgets.child(itemContainer, pos);
            if (c) this.drawItem(l, c, bank, bankItemId, pos);
        });

        let insertionSlot = (this.plugin.getOptions() & OPTION_ITEMS_NOT_IN_LAYOUT_AT_BOTTOM) !== 0 ? l.lastItemIndex() : -1;
        let modified = false;
        // The bank's items that aren't in the layout.
        for (const itemId of bankItems) {
            do ++insertionSlot;
            while (l.getItemAtPos(insertionSlot) > -1);
            const c = this.widgets.child(itemContainer, insertionSlot);
            if (!c || c.rawHeight !== BANK_ITEM_HEIGHT) break; // the tab separators
            this.drawItem(l, c, bank, itemId, insertionSlot);
            l.addItemAfter(this.client.canonicalize(itemId), insertionSlot);
            modified = true;
        }

        // Empty the remaining slots, so items can be dragged to them.
        insertionSlot = -1;
        for (;;) {
            do ++insertionSlot;
            while (l.getItemAtPos(insertionSlot) > -1);
            const c = this.widgets.child(itemContainer, insertionSlot);
            if (!c || c.rawHeight !== BANK_ITEM_HEIGHT) break;
            this.drawItem(l, c, bank, -1, insertionSlot);
        }

        if (modified) this.saveLayout(l);
    }

    /** Mostly ~bankmain_drawitem. */
    private drawItem(l: Layout, c: WidgetNode, bank: Inventory, item: number, idx: number): void {
        const w = this.widgets;
        if (item > -1 && item !== BANK_FILLER) {
            const def = this.client.getItemDefinition(item);
            const qty = bank.count(item);

            w.setItem(c, item, qty, ItemQuantityMode.STACKABLE);
            w.setName(c, `<col=ff9040>${def?.name ?? ""}</col>`);
            w.clearActions(c);

            if ((def?.placeholderTemplate ?? -1) >= 0 && (def?.placeholder ?? -1) >= 0) {
                // A Jagex placeholder.
                w.setItem(c, item, qty);
                w.setOpacity(c, 120);
                w.setAction(c, 8 - 1, "Release");
                w.setAction(c, 10 - 1, "Examine");
            } else if (qty === 0) {
                // A layout placeholder.
                w.setOpacity(c, 120);
                w.setItem(c, item, 0x7fffffff, ItemQuantityMode.NEVER);
                if ((this.plugin.getOptions() & OPTION_ALLOW_MODIFICATIONS) !== 0) {
                    // TabInterface handles these locally.
                    w.setAction(c, 7 - 1, DUPLICATE_ITEM);
                    w.setAction(c, 8 - 1, REMOVE_LAYOUT);
                }
            } else {
                const quantityType = this.client.getVarbitValue(BANK_QUANTITY_TYPE);
                const requestQty = this.client.getVarbitValue(BANK_REQUESTEDQUANTITY);
                const suffix = ["1", "5", "10", String(Math.max(1, requestQty)), "All"][quantityType] ?? "1";
                // ~script669
                w.setAction(c, 0, `Withdraw-${suffix}`);
                if (quantityType !== 0) w.setAction(c, 1, "Withdraw-1");
                w.setAction(c, 2, "Withdraw-5");
                w.setAction(c, 3, "Withdraw-10");
                if (requestQty > 0) w.setAction(c, 4, `Withdraw-${requestQty}`);
                w.setAction(c, 5, "Withdraw-X");
                w.setAction(c, 6, "Withdraw-All");
                w.setAction(c, 7, "Withdraw-All-but-1");
                if (this.client.getVarbitValue(BANK_BANKOPS_TOGGLE_ON) === 1 && intParam(def, PARAM_BANK_AUTOCHARGE) !== -1) {
                    w.setAction(c, 8, "Configure-Charges");
                }
                if (this.client.getVarbitValue(BANK_LEAVEPLACEHOLDERS) === 0) w.setAction(c, 9, "Placeholder");
                w.setAction(c, 10, "Examine");
                w.setOpacity(c, 0);
            }

            w.setOnDragListener(c, [
                ScriptID.BANKMAIN_DRAGSCROLL,
                ScriptArgMagic.WIDGET_ID,
                ScriptArgMagic.WIDGET_CHILD_INDEX,
                ScriptArgMagic.MOUSE_X,
                ScriptArgMagic.MOUSE_Y,
                Bankmain.SCROLLBAR,
                0,
            ]);
            w.listen(c, { onDragComplete: (ev: { source: WidgetNode; target: WidgetNode | null }) => this.dragComplete(l, ev) });
        } else {
            // Pad the size so there's no gap between items.
            w.setOriginalWidth(c, BANK_ITEM_WIDTH + BANK_ITEM_X_PADDING);
            w.setOriginalHeight(c, BANK_ITEM_HEIGHT + BANK_ITEM_Y_PADDING);
            w.clearActions(c);
            w.setItem(c, -1, 0);
            w.setOnDragListener(c, null);
            w.listen(c, { onDragComplete: () => this.client.setDraggedOnWidget(undefined) });
        }

        w.setHidden(c, false);
        w.setOriginalX(c, (idx % BANK_ITEMS_PER_ROW) * (BANK_ITEM_WIDTH + BANK_ITEM_X_PADDING) + BANK_ITEM_START_X);
        w.setOriginalY(c, Math.floor(idx / BANK_ITEMS_PER_ROW) * (BANK_ITEM_HEIGHT + BANK_ITEM_Y_PADDING));
        w.revalidate(c);
    }

    private dragComplete(l: Layout, ev: { source: WidgetNode; target: WidgetNode | null }): void {
        // Always block the drag: the bank's order doesn't change.
        this.client.setDraggedOnWidget(undefined);
        const { source, target } = ev;
        if (!target) return;
        if (this.widgets.id(source) !== Bankmain.ITEMS || this.widgets.id(target) !== Bankmain.ITEMS) return;

        const sidx = this.widgets.index(source);
        const tidx = this.widgets.index(target);
        if (sidx >= l.size() || tidx >= l.size()) l.resize(Math.max(sidx, tidx) + 1);
        if (this.client.getVarbitValue(BANK_INSERTMODE) === 0) l.swap(sidx, tidx);
        else l.insert(sidx, tidx);
        this.saveLayout(l);
        this.bankSearch.layoutBank();
    }

    private matchPlaceholder(bank: Set<number>, itemId: number): number {
        const placeholderId = this.client.getItemDefinition(itemId)?.placeholder ?? -1;
        return placeholderId !== -1 && bank.has(placeholderId) ? placeholderId : -1;
    }

    private matchesVariant(bank: Set<number>, itemId: number): number {
        const variations = getVariations(mapVariation(itemId));
        if (variations.length <= 1) return -1;
        for (const variationId of variations) {
            if (bank.has(variationId)) return variationId;
            const placeholderId = this.client.getItemDefinition(variationId)?.placeholder ?? -1;
            if (placeholderId !== -1 && bank.has(placeholderId)) return placeholderId;
        }
        return -1;
    }

    /** MenuEntryAdded: "Auto layout: <name>" on a laid-out tag tab. */
    addMenuEntries(entries: SimpleMenuEntry[], ctx: BankMenuContext, tabInterface: TabInterface): SimpleMenuEntry[] {
        if (ctx.componentId !== Bankmain.ITEMS_CONTAINER) return entries;
        const at = entries.findIndex((e) => e.option === DISABLE_LAYOUT);
        if (at < 0) return entries;
        const disable = entries[at];
        // createMenuEntry(--idx) from -2 as "Disable layout" is added: each just below it, in order.
        const added = this.autoLayouts.map(({ name, autoLayout }) => ({
            option: `Auto layout: ${name}`,
            target: disable.target ?? "",
            onClick: () => {
                const tag = standardize(disable.target ?? "");
                if (tag !== tabInterface.getActiveTag()) {
                    this.client.sendChatMessage("The tag tab must be open first before performing an auto layout.");
                    return;
                }
                const old = this.plugin.getActiveLayout();
                const generated = autoLayout.generateLayout(old ?? new Layout(tag));
                this.plugin.openTag(tag, generated);
                this.chatbox
                    .openTextMenuInput(`Tab laid out using the '${name}' layout.`)
                    .option("1. Keep", () => this.saveLayout(generated))
                    .option("2. Undo", () => this.plugin.openTag(tag, old))
                    .onClose(() => this.bankSearch.layoutBank())
                    .build();
            },
        }));
        return [...entries.slice(0, at + 1), ...added, ...entries.slice(at + 1)];
    }

    /** MenuOptionClicked: a withdraw from a laid-out tab uses the item's real bank slot. */
    onMenuOptionClicked(event: WidgetActionEvent): void {
        const widget = event.widget as WidgetNode | undefined;
        if (!widget || this.widgets.id(widget) !== Bankmain.ITEMS || this.plugin.getActiveLayout() === null) return;
        if ((widget.itemId ?? -1) <= -1) return;
        const idx = this.client.getItemContainer(BANK)?.findSlotWithItem(widget.itemId!) ?? -1;
        if (idx > -1 && event.slot !== idx) event.slot = idx;
    }

    /** Keeps some of the layout's items in view. */
    private scrollLayout(l: Layout): void {
        let pos = l.size() - 1;
        while (pos >= 0 && l.getItemAtPos(pos) === -1) --pos;
        let rows = Math.floor((pos + BANK_ITEMS_PER_ROW - 1) / BANK_ITEMS_PER_ROW);
        let scrollY = rows * (BANK_ITEM_HEIGHT + BANK_ITEM_Y_PADDING);

        const w = this.client.getWidget(Bankmain.ITEMS);
        if (!w || scrollY >= (w.scrollY ?? 0)) return;
        const bankHeight = Math.floor(this.widgets.height(w) / (BANK_ITEM_HEIGHT + BANK_ITEM_Y_PADDING));
        rows = Math.max(0, rows - bankHeight);
        scrollY = rows * (BANK_ITEM_HEIGHT + BANK_ITEM_Y_PADDING);
        this.widgets.setScrollY(w, scrollY);
        this.client.setVarcIntValue(BANK_SCROLLPOS, scrollY);
    }

    /** RuneLite's "Default" auto layout: worn gear, the inventory, the rune pouch and the quiver. */
    private defaultLayout(previous: Layout): Layout {
        const l = new Layout(previous);
        const removed: number[] = [];

        const worn = this.client.getItemContainer(WORN);
        if (worn) {
            const S = EquipmentSlot;
            const format = [-1, S.HEAD, -1, S.CAPE, S.AMULET, S.AMMO, S.WEAPON, S.BODY, S.SHIELD, -1, S.LEGS, -1, S.GLOVES, S.BOOTS, S.RING];
            for (let pos = 0, base = 0; pos < format.length; ++pos) {
                if (pos > 0 && pos % 3 === 0) base += 8;
                const lpos = base + (pos % 3);
                const old = l.getItemAtPos(lpos);
                if (old !== -1) removed.push(old);
                const item = format[pos] >= 0 ? worn.getSlot(format[pos]) : undefined;
                l.setItemAtPos(item && item.itemId >= 0 ? this.client.canonicalize(item.itemId) : -1, lpos);
            }
        }

        const inv = this.client.getItemContainer(INV);
        if (inv) {
            for (let pos = 0, base = 4; pos < inv.capacity; ++pos) {
                if (pos > 0 && pos % 4 === 0) base += 8;
                const lpos = base + (pos % 4);
                const old = l.getItemAtPos(lpos);
                if (old !== -1) removed.push(old);
                const item = inv.getSlot(pos);
                l.setItemAtPos(item && item.itemId >= 0 ? this.client.canonicalize(item.itemId) : -1, lpos);
            }
        }

        if (inv && this.hasRunePouch(inv)) {
            const runes = [RUNE_POUCH_TYPE_1, RUNE_POUCH_TYPE_2, RUNE_POUCH_TYPE_3, RUNE_POUCH_TYPE_4];
            let lpos = 40;
            for (const varbit of runes) {
                const runeId = this.client.getVarbitValue(varbit);
                if (runeId > 0) {
                    const old = l.getItemAtPos(lpos);
                    if (old !== -1) removed.push(old);
                    l.setItemAtPos(this.client.getEnumIntValue(ENUM_RUNEPOUCH_RUNE, runeId), lpos);
                }
                ++lpos;
            }
        }

        if (this.hasQuiver(inv, worn)) l.setItemAtPos(this.client.getVarpValue(DIZANAS_QUIVER_TEMP_AMMO), 2);

        // The middle column.
        for (let j = 0; j < 5; ++j) {
            const idx = j * 8 + 3;
            const old = l.getItemAtPos(idx);
            if (old !== -1) {
                removed.push(old);
                l.setItemAtPos(-1, idx);
            }
        }

        let pos = 56;
        for (const itemId of removed) if (l.count(itemId) === 0) l.addItemAfter(itemId, pos++);
        return l;
    }

    private hasRunePouch(inv: Inventory): boolean {
        const pouches = [...getVariations(BH_RUNE_POUCH), ...getVariations(DIVINE_RUNE_POUCH)];
        return pouches.some((id) => inv.count(id) > 0);
    }

    private hasQuiver(inv: Inventory | undefined, worn: Inventory | undefined): boolean {
        const ammo = (id: number) => intParam(this.client.getItemDefinition(id), PARAM_QUIVER_AMMO_AVAILABLE) === 1;
        const cape = worn?.getSlot(EquipmentSlot.CAPE);
        return (cape !== undefined && cape.itemId >= 0 && ammo(cape.itemId)) || (inv?.getSlots().some((s) => s.itemId >= 0 && ammo(s.itemId)) ?? false);
    }
}

function intParam(def: { params?: Map<number, number | string> } | undefined, id: number): number {
    const v = def?.params?.get(id);
    return v === undefined ? -1 : Number(v);
}
