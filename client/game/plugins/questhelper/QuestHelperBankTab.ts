import { BANK } from "@runelite/api/gameval/InventoryID";
import { MESLAYERINPUT, MESLAYERMODE } from "@runelite/api/gameval/VarClientID";
import {
    BANK_BANKOPS_TOGGLE_ON,
    BANK_CURRENTTAB,
    BANK_LEAVEPLACEHOLDERS,
    BANK_QUANTITY_TYPE,
    BANK_REQUESTEDQUANTITY,
} from "@runelite/api/gameval/VarbitID";
import { BANK_FILLER, BLANKOBJECT } from "@runelite/api/gameval/ItemID";
import { ScriptArgMagic } from "../../../rs/cs2/Cs2Vm";
import { WidgetType } from "../../../widgets/custom/dynamicWidgets";
import type { WidgetNode } from "../../../widgets/WidgetNode";
import type { WidgetActionEvent } from "../../widgets/widgetActionPayload";
import type { BankTagsClient } from "../banktags/bankClient";
import {
    BANK_ITEM_HEIGHT,
    BANK_ITEM_WIDTH,
    BANK_ITEM_X_PADDING,
    BANK_ITEM_Y_PADDING,
    Bankmain,
    PARAM_BANK_AUTOCHARGE,
    SOUND_UI_BOOP,
    ScriptID,
} from "../banktags/bankmain";
import { BankSearch } from "../banktags/BankSearch";
import { BankWidgets, ItemQuantityMode } from "../banktags/bankWidgets";
import type { HelperBankTab, HelperBankTabItem, HelperBankTabSection } from "./QuestHelperProtocol";

const ITEMS_PER_ROW = 8;
const ITEM_VERTICAL_SPACING = 36;
const ITEM_HORIZONTAL_SPACING = 48;
const ITEM_ROW_START = 51;
const LINE_VERTICAL_SPACING = 5;
const LINE_HEIGHT = 2;
const TEXT_HEIGHT = 15;
const VIEW_TAB = "View tab ";
/** BANK_CURRENTTAB's potion store tab. */
const BANKTAB_POTIONSTORE = 15;
/** ScriptID.BANKMAIN_SEARCHING and UPDATE_SCROLLBAR. */
const BANKMAIN_SEARCHING = 514;
const UPDATE_SCROLLBAR = 72;
/** RuneLite's SpriteID values QuestBankTab uses. */
const Sprite = {
    UNKNOWN_BUTTON_SQUARE_SMALL: 195,
    UNKNOWN_BUTTON_SQUARE_SMALL_SELECTED: 196,
    BLUE_QUESTS: 835,
    CROSSED: 1216,
    CHECKED: 1217,
    EQUIPMENT_SLOT_TILE: 170,
    TRADEBACKING_DARK: 897,
} as const;
/** FontID.PLAIN_11. */
const FONT_PLAIN_11 = 494;
/** The section titles' colour, new Color(228, 216, 162). */
const TITLE_COLOR = 0xe4d8a2;
const NON_QUEST_ITEMS = "Non-quest items";

/** A requirement's "/ goal" text and tick or cross, drawn after every item (QuestBankTab's BankText). */
type BankText = { text: string; x: number; y: number; spriteId: number; spriteX: number; spriteY: number };

/** What the bank tab reads of Quest Helper. */
export interface QuestBankTabHost {
    /** The selected quest's name, or null when none is. */
    selectedQuestName(): string | null;
    /** The last evaluation's bank tab (QuestHelperPlugin.getPluginBankTagItemsForSections), if any. */
    bankTab(): HelperBankTab | undefined;
    /** ChatMessageManager: a message in the chatbox. */
    sendChatMessage(message: string): void;
}

/**
 * Quest Helper's bank tab (upstream QuestBankTabInterface and QuestBankTab, at 06da90f): a
 * "quest-helper" button by the bank's tabs that shows the quest's items in sections (recommended,
 * then each part of the quest, then everything else), with what's missing as placeholders, the
 * amount needed and a tick or cross. Withdrawing works from it; "Details" on a missing item says
 * what's needed.
 */
export class QuestHelperBankTab {
    questTabActive = false;
    private questBackgroundWidget?: WidgetNode;
    private questIconWidget?: WidgetNode;
    private readonly addedWidgets: WidgetNode[] = [];
    private readonly widgetItems = new Map<WidgetNode, HelperBankTabItem>();
    private originalContainerChildren = -1;
    private currentWidgetToUse = 0;
    /** Bumped by every build, so only the latest build's layout runs. */
    private buildGeneration = 0;
    private readonly widgets: BankWidgets;
    private readonly bankSearch: BankSearch;

    constructor(
        private readonly client: BankTagsClient,
        private readonly host: QuestBankTabHost,
    ) {
        this.widgets = new BankWidgets(() => client.widgets);
        this.bankSearch = new BankSearch(client);
    }

    // ------------------------------------------------------------------ QuestBankTabInterface

    isHidden(): boolean {
        const widget = this.client.getWidget(Bankmain.UNIVERSE);
        return !widget || this.widgets.isHidden(widget);
    }

    /** WidgetLoaded for the bank (or startUp with the bank open): the "quest-helper" button. */
    init(): void {
        if (this.isHidden() || this.host.selectedQuestName() === null) return;
        const parent = this.client.getWidget(Bankmain.UNIVERSE)!;
        if (this.questBackgroundWidget && this.widgets.parent(this.questBackgroundWidget) === parent) return;

        const SIZE = 25;
        const X = 408;
        const Y = 5;
        const background = this.createGraphic(parent, "quest-helper", Sprite.UNKNOWN_BUTTON_SQUARE_SMALL, SIZE, SIZE, X, Y);
        this.widgets.setAction(background, 1, VIEW_TAB);
        this.widgets.listen(background, { onOp: (event: WidgetActionEvent) => this.handleTagTab(event) });
        this.questBackgroundWidget = background;
        this.questIconWidget = this.createGraphic(parent, "", Sprite.BLUE_QUESTS, SIZE - 6, SIZE - 6, X + 3, Y + 3);

        if (this.questTabActive) {
            const wasInPotionStorage = this.client.getVarbitValue(BANK_CURRENTTAB) === BANKTAB_POTIONSTORE;
            this.questTabActive = false;
            queueMicrotask(() => this.activateTab(wasInPotionStorage));
        }
    }

    destroy(): void {
        if (this.questTabActive) {
            this.closeTab();
            this.bankSearch.reset(true);
        }
        if (this.questIconWidget) this.widgets.setHidden(this.questIconWidget, true);
        if (this.questBackgroundWidget) this.widgets.setHidden(this.questBackgroundWidget, true);
        this.questIconWidget = this.questBackgroundWidget = undefined;
        this.questTabActive = false;
        this.removeAddedWidgets();
    }

    /** WidgetClosed for the bank: its widgets are gone. */
    onBankClosed(): void {
        this.questIconWidget = this.questBackgroundWidget = undefined;
        this.addedWidgets.length = 0;
        this.widgetItems.clear();
        this.originalContainerChildren = -1;
    }

    /** Lays the open tab out again (the quest's items changed). */
    refreshTab(): void {
        if (!this.questTabActive) return;
        this.client.setVarbit(BANK_CURRENTTAB, 0);
        this.bankSearch.reset(true);
        this.resetSearchButton();
    }

    private handleTagTab(event: WidgetActionEvent): void {
        if (event.opIndex !== 2) return;
        const wasInPotionStorage = this.client.getVarbitValue(BANK_CURRENTTAB) === BANKTAB_POTIONSTORE;
        this.client.setVarbit(BANK_CURRENTTAB, 0);
        if (this.questTabActive) {
            this.closeTab();
            this.bankSearch.reset(true);
        } else {
            this.activateTab(wasInPotionStorage);
        }
        this.client.playSoundEffect(SOUND_UI_BOOP);
    }

    closeTab(): void {
        this.questTabActive = false;
        if (this.questBackgroundWidget) {
            this.widgets.setSpriteId(this.questBackgroundWidget, Sprite.UNKNOWN_BUTTON_SQUARE_SMALL);
            this.widgets.revalidate(this.questBackgroundWidget);
        }
    }

    private activateTab(_wasInPotionStorage: boolean): void {
        // The offline server has no potion storage to close first.
        if (this.questTabActive || !this.questBackgroundWidget) return;
        this.widgets.setSpriteId(this.questBackgroundWidget, Sprite.UNKNOWN_BUTTON_SQUARE_SMALL_SELECTED);
        this.widgets.revalidate(this.questBackgroundWidget);
        this.questTabActive = true;
        // Clears the search input and lays the bank out for the tab.
        this.bankSearch.reset(true);
        this.resetSearchButton();
    }

    /**
     * Going from a bank search to the tab, the search button's timer would re-add itself and
     * reset its background, so both go now (as bankmain_search_setbutton does).
     */
    private resetSearchButton(): void {
        const search = this.client.getWidget(Bankmain.SEARCH_BUTTON);
        if (!search) return;
        const w = search as any;
        w.onTimer = null;
        if (w.eventHandlers) delete w.eventHandlers.onTimer;
        this.widgets.setSpriteId(search, Sprite.EQUIPMENT_SLOT_TILE);
    }

    // ------------------------------------------------------------------ QuestBankTab

    onScriptPreFired(scriptId: number): void {
        if (scriptId === ScriptID.BANKMAIN_FINISHBUILDING) {
            this.resetWidgets();
            if (this.questTabActive) {
                const title = this.client.getWidget(Bankmain.TITLE);
                if (title) this.widgets.setText(title, `Tab <col=ff0000>${this.host.selectedQuestName() ?? "Quest Helper"}</col>`);
            }
        } else if (scriptId === ScriptID.BANKMAIN_SEARCH_TOGGLE) {
            this.handleSearch();
        }
    }

    /** QuestBankTabInterface.handleSearch: Search closes the tab and opens the input. */
    private handleSearch(): void {
        if (!this.questTabActive) return;
        this.closeTab();
        this.client.setVarcStrValue(MESLAYERINPUT, "");
        this.client.setVarcIntValue(MESLAYERMODE, 0);
    }

    /** ScriptCallbackEvent "getSearchingTagTab": the bank isn't re-laid out by the server. */
    onScriptCallback(eventName: string): void {
        const vm = this.client.vm;
        if (eventName === "getSearchingTagTab" && this.questTabActive && vm) vm.intStack[vm.intStackSize - 1] = 1;
    }

    onScriptPostFired(scriptId: number): void {
        const vm = this.client.vm;
        if (scriptId === BANKMAIN_SEARCHING) {
            // Its return value is on the stack: with the tab open the bank is "searching".
            if (this.questTabActive && vm) vm.intStack[vm.intStackSize - 1] = 1;
            return;
        }
        if (scriptId !== ScriptID.BANKMAIN_FINISHBUILDING) return;

        this.buildGeneration++;
        this.removeAddedWidgets();
        if (!this.questTabActive) return;
        const itemContainer = this.client.getWidget(Bankmain.ITEMS);
        if (!itemContainer) return;
        const children = this.widgets.children(itemContainer);
        if (this.originalContainerChildren === -1) this.originalContainerChildren = children.length;
        const containerChildren = [...children];
        const generation = ++this.buildGeneration;
        // invokeAtTickEnd: after the bank's build has finished.
        queueMicrotask(() => {
            if (generation !== this.buildGeneration || !this.questTabActive) return;
            const tab = this.host.bankTab();
            if (tab) this.sortBankTabItems(itemContainer, containerChildren, tab.sections);
        });
    }

    /** MenuOptionClicked. Returns true when the click is handled here. */
    onMenuOptionClicked(event: WidgetActionEvent): boolean {
        const option = String(event.option ?? "");
        const target = String(event.target ?? "");
        // Another tab, or the potion store, closes this one.
        if (!this.isHidden() && this.questTabActive) {
            const clickedTabTag = option.startsWith("View tab") && removeTags(target) !== "quest-helper";
            const clickedOtherTab = option === "View all items" || option.startsWith("View tag tab");
            if (clickedTabTag || clickedOtherTab || option.startsWith("Potion store")) this.closeTab();
        }

        const widget = event.widget as WidgetNode | undefined;
        if (!widget || this.widgets.id(widget) !== Bankmain.ITEMS || !this.questTabActive) return false;
        if (option === "Details") {
            const item = this.widgetItems.get(widget);
            if (item) this.handleFakeItemClick(item);
            return true;
        }
        // A withdraw uses the item's real bank slot.
        if ((widget.itemId ?? -1) > -1) {
            const idx = this.client.getItemContainer(BANK)?.findSlotWithItem(widget.itemId!) ?? -1;
            if (idx > -1 && event.slot !== idx) event.slot = idx;
        }
        return false;
    }

    /** The bank's item children are only sized when it opens; a layout changes them. */
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

    private removeAddedWidgets(): void {
        if (this.originalContainerChildren === -1 || this.addedWidgets.length === 0) return;
        const parent = this.widgets.parent(this.addedWidgets[0]);
        this.addedWidgets.length = 0;
        if (!parent) return;
        this.widgets.truncateChildren(parent, this.originalContainerChildren);
        this.widgets.revalidate(parent);
    }

    private sortBankTabItems(itemContainer: WidgetNode, containerChildren: WidgetNode[], layout: HelperBankTabSection[]): void {
        let totalSectionsHeight = 0;
        this.widgetItems.clear();
        // Hide the bank's widgets: this tab draws with them.
        this.hideBankWidgets(itemContainer, containerChildren);
        for (const w of containerChildren) {
            if (w && (w.spriteId === Sprite.TRADEBACKING_DARK || String(w.text ?? "").includes("Tab"))) this.widgets.setHidden(w, true);
        }

        const bankItemTexts: BankText[] = [];
        const newLayout = [...layout, this.remainingBankTab(layout)];
        this.currentWidgetToUse = 0;
        for (const section of newLayout) totalSectionsHeight = this.addPluginTabSection(itemContainer, section, totalSectionsHeight, bankItemTexts);

        // The texts go after every item, so they're always on top.
        for (const bankText of bankItemTexts) {
            this.addedWidgets.push(this.createText(itemContainer, bankText.text, 0xffffff, ITEM_HORIZONTAL_SPACING, TEXT_HEIGHT - 3, bankText.x, bankText.y));
            if (bankText.spriteId !== -1) this.addedWidgets.push(this.createIcon(itemContainer, bankText.spriteId, bankText.spriteX, bankText.spriteY));
        }
        this.currentWidgetToUse = 0;

        const height = this.widgets.height(itemContainer);
        itemContainer.scrollHeight = Math.max(totalSectionsHeight, height);
        this.client.widgets.invalidateWidget(itemContainer);
        this.client.runScript(UPDATE_SCROLLBAR, Bankmain.SCROLLBAR, Bankmain.ITEMS, itemContainer.scrollY ?? 0);
    }

    /** "Non-quest items": the bank's items that no section uses. */
    private remainingBankTab(layout: HelperBankTabSection[]): HelperBankTabSection {
        const leftover: HelperBankTabSection = { name: NON_QUEST_ITEMS, items: [], recommendedItems: [] };
        const bank = this.client.getItemContainer(BANK);
        if (!bank) return leftover;
        const used = new Set<number>();
        for (const tab of layout) for (const item of [...tab.items, ...tab.recommendedItems]) for (const id of item.itemIds) used.add(id);
        const seen = new Set<number>();
        for (const slot of bank.getSlots()) {
            const id = slot.itemId;
            if (id < 0 || used.has(id) || seen.has(id)) continue;
            seen.add(id);
            // new ItemRequirement(name, id, -1): no amount, so no "/ n" text.
            leftover.items.push({ quantity: -1, text: this.client.getItemDefinition(id)?.name ?? "", itemIds: [id], displayId: id, met: true });
        }
        return leftover;
    }

    private hideBankWidgets(itemContainer: WidgetNode, containerChildren: WidgetNode[]): void {
        for (let i = 0; i < containerChildren.length; ++i) {
            const widget = this.widgets.child(itemContainer, i);
            if (!widget) continue;
            // ~bankmain_drawitem uses 6512 for empty slots.
            if (
                (!this.widgets.isSelfHidden(widget) && (widget.itemId ?? -1) > -1 && widget.itemId !== BLANKOBJECT) ||
                widget.spriteId === Sprite.TRADEBACKING_DARK ||
                String(widget.text ?? "").includes("Tab")
            ) {
                this.widgets.setHidden(widget, true);
            }
        }
    }

    private drawItem(c: WidgetNode, item: number, bankTabItem: HelperBankTabItem): void {
        const w = this.widgets;
        const bank = this.client.getItemContainer(BANK);
        if (item > -1 && item !== BANK_FILLER && bank) {
            const qty = bank.count(item);
            const def = this.client.getItemDefinition(item);
            w.setItem(c, item, qty, ItemQuantityMode.ALWAYS);
            // Effectively no dragging.
            w.setDragDeadTime(c, 1000);
            w.setName(c, `<col=ff9040>${def?.name ?? ""}</col>`);
            w.clearActions(c);

            if ((def?.placeholderTemplate ?? -1) >= 0 && (def?.placeholder ?? -1) >= 0) {
                // A Jagex placeholder.
                w.setItem(c, item, qty);
                w.setOpacity(c, 120);
                w.setAction(c, 8 - 1, "Release");
                w.setAction(c, 10 - 1, "Examine");
            } else if (qty === 0) {
                // A missing item.
                w.setOpacity(c, 120);
                w.setItem(c, item, 0, ItemQuantityMode.ALWAYS);
                w.setText(c, `<col=ff9040>${bankTabItem.text ?? ""}</col>`);
                w.setAction(c, 1, "Details");
            } else {
                const quantityType = this.client.getVarbitValue(BANK_QUANTITY_TYPE);
                const requestQty = this.client.getVarbitValue(BANK_REQUESTEDQUANTITY);
                // ~script2759, ~script669
                const suffix = ["1", "5", "10", String(Math.max(1, requestQty)), "All"][quantityType] ?? "1";
                w.setAction(c, 0, `Withdraw-${suffix}`);
                if (quantityType !== 0) w.setAction(c, 1, "Withdraw-1");
                w.setAction(c, 2, "Withdraw-5");
                w.setAction(c, 3, "Withdraw-10");
                if (requestQty > 0) w.setAction(c, 4, `Withdraw-${requestQty}`);
                w.setAction(c, 5, "Withdraw-X");
                w.setAction(c, 6, "Withdraw-All");
                w.setAction(c, 7, "Withdraw-All-but-1");
                if (this.client.getVarbitValue(BANK_BANKOPS_TOGGLE_ON) === 1 && Number(def?.params?.get(PARAM_BANK_AUTOCHARGE) ?? -1) !== -1) {
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
            w.listen(c, { onDragComplete: () => {} });
        } else {
            // Pad the size so there's no gap between items.
            w.setOriginalWidth(c, BANK_ITEM_WIDTH + BANK_ITEM_X_PADDING);
            w.setOriginalHeight(c, BANK_ITEM_HEIGHT + BANK_ITEM_Y_PADDING);
            w.clearActions(c);
            w.setItem(c, -1, 0);
            w.setOnDragListener(c, null);
            w.unlisten(c, "onDragComplete");
        }
        this.widgetItems.set(c, bankTabItem);
        w.setHidden(c, false);
        w.revalidate(c);
    }

    private addPluginTabSection(itemContainer: WidgetNode, items: HelperBankTabSection, totalSectionsHeight: number, bankItemTexts: BankText[]): number {
        if (items.items.length === 0 && items.recommendedItems.length === 0) return totalSectionsHeight;
        let newHeight = this.addSectionHeader(itemContainer, items.name, totalSectionsHeight);
        if (items.items.length) newHeight = this.createPartialSection(items.items, newHeight, bankItemTexts);
        if (items.recommendedItems.length) {
            newHeight = this.addSubSectionHeader(itemContainer, "Recommended", newHeight);
            newHeight = this.createPartialSection(items.recommendedItems, newHeight, bankItemTexts);
        }
        return newHeight;
    }

    private createPartialSection(items: HelperBankTabItem[], totalSectionsHeight: number, bankItemTexts: BankText[]): number {
        let totalItemsAdded = 0;
        const container = this.client.getWidget(Bankmain.ITEMS);
        if (!container || !this.client.getItemContainer(BANK)) return totalSectionsHeight;
        for (const item of items) {
            const itemId = item.displayId;
            if (itemId === -1) continue;
            const c = this.widgets.child(container, this.currentWidgetToUse);
            if (!c) return totalSectionsHeight;
            this.drawItem(c, itemId, item);
            this.placeItem(c, totalItemsAdded, totalSectionsHeight);
            if (item.quantity > 0) this.makeBankText(c.itemQuantity ?? 0, item.quantity, c.rawX ?? 0, c.rawY ?? 0, item.met, bankItemTexts);
            this.currentWidgetToUse++;
            totalItemsAdded++;
        }
        let newHeight = totalSectionsHeight + Math.floor(totalItemsAdded / ITEMS_PER_ROW) * ITEM_VERTICAL_SPACING;
        if (totalItemsAdded % ITEMS_PER_ROW !== 0) newHeight += ITEM_VERTICAL_SPACING;
        return newHeight;
    }

    private makeBankText(currentQuantity: number, goalQuantity: number, baseX: number, baseY: number, hasItem: boolean, out: BankText[]): void {
        const quantityString = quantityToStackSize(goalQuantity);
        const requirementLength = Math.round(quantityString.length * 5.5);
        const extraLength = quantityToStackSize(currentQuantity).length * 6;
        let xPos = baseX + 2 + extraLength;
        let yPos = baseY - 1;
        if (extraLength + requirementLength > 20) {
            xPos = baseX;
            yPos = baseY + 9;
        }
        let spritePosX = xPos + requirementLength + 10;
        let spritePosY = yPos;
        // The required amount moved down a line: the tick or cross goes after the current one.
        if (yPos !== baseY - 1) {
            spritePosX = baseX + 2 + extraLength;
            spritePosY = baseY - 1;
        }
        out.push({ text: `/ ${quantityString}`, x: xPos, y: yPos, spriteId: hasItem ? Sprite.CHECKED : Sprite.CROSSED, spriteX: spritePosX, spriteY: spritePosY });
    }

    private addSubSectionHeader(itemContainer: WidgetNode, title: string, totalSectionsHeight: number): number {
        this.addedWidgets.push(
            this.createText(itemContainer, title, TITLE_COLOR, ITEMS_PER_ROW * ITEM_HORIZONTAL_SPACING + ITEM_ROW_START, TEXT_HEIGHT, ITEM_ROW_START, totalSectionsHeight + LINE_VERTICAL_SPACING),
        );
        return totalSectionsHeight + LINE_VERTICAL_SPACING + TEXT_HEIGHT;
    }

    private addSectionHeader(itemContainer: WidgetNode, title: string, totalSectionsHeight: number): number {
        this.addedWidgets.push(this.createLine(itemContainer, ITEM_ROW_START, totalSectionsHeight));
        return this.addSubSectionHeader(itemContainer, title, totalSectionsHeight);
    }

    private placeItem(widget: WidgetNode, totalItemsAdded: number, totalSectionsHeight: number): void {
        const y = totalSectionsHeight + Math.floor(totalItemsAdded / ITEMS_PER_ROW) * ITEM_VERTICAL_SPACING;
        const x = (totalItemsAdded % ITEMS_PER_ROW) * ITEM_HORIZONTAL_SPACING + ITEM_ROW_START;
        if (widget.rawY !== y || widget.rawX !== x) {
            this.widgets.setOriginalX(widget, x);
            this.widgets.setOriginalY(widget, y);
            this.widgets.revalidate(widget);
        }
    }

    private handleFakeItemClick(item: HelperBankTabItem): void {
        const quantity = item.quantity === -1 ? "some " : `${item.quantity.toLocaleString("en-US")} x `;
        let message = `You need <col=ff0000>${quantity}${removeTags(item.text ?? "")}</col>.`;
        if (item.details) message += ` ${item.details}.`;
        this.host.sendChatMessage(message);
    }

    private createGraphic(container: WidgetNode, name: string, spriteId: number, width: number, height: number, x: number, y: number): WidgetNode {
        const widget = this.widgets.createChild(container, WidgetType.GRAPHIC);
        this.widgets.setOriginalWidth(widget, width);
        this.widgets.setOriginalHeight(widget, height);
        this.widgets.setOriginalX(widget, x);
        this.widgets.setOriginalY(widget, y);
        this.widgets.setSpriteId(widget, spriteId);
        this.widgets.setHasListener(widget);
        this.widgets.setName(widget, name);
        this.widgets.revalidate(widget);
        return widget;
    }

    /** The section's dividing line (TRADEBACKING_DARK, two pixels high). */
    private createLine(container: WidgetNode, x: number, y: number): WidgetNode {
        const widget = this.widgets.createChild(container, WidgetType.GRAPHIC);
        this.widgets.setOriginalWidth(widget, ITEMS_PER_ROW * ITEM_HORIZONTAL_SPACING);
        this.widgets.setOriginalHeight(widget, LINE_HEIGHT);
        this.widgets.setOriginalX(widget, x);
        this.widgets.setOriginalY(widget, y);
        this.widgets.setSpriteId(widget, Sprite.TRADEBACKING_DARK);
        this.widgets.revalidate(widget);
        return widget;
    }

    private createText(container: WidgetNode, text: string, color: number, width: number, height: number, x: number, y: number): WidgetNode {
        const widget = this.widgets.createChild(container, WidgetType.TEXT);
        this.widgets.setOriginalWidth(widget, width);
        this.widgets.setOriginalHeight(widget, height);
        this.widgets.setOriginalX(widget, x);
        this.widgets.setOriginalY(widget, y);
        this.widgets.setText(widget, text);
        widget.fontId = FONT_PLAIN_11;
        widget.textColor = widget.color = color;
        (widget as any).textShadowed = widget.textShadow = true;
        this.widgets.revalidate(widget);
        return widget;
    }

    private createIcon(container: WidgetNode, spriteId: number, x: number, y: number): WidgetNode {
        const widget = this.widgets.createChild(container, WidgetType.GRAPHIC);
        this.widgets.setOriginalWidth(widget, 10);
        this.widgets.setOriginalHeight(widget, 10);
        this.widgets.setOriginalX(widget, x);
        this.widgets.setOriginalY(widget, y);
        this.widgets.setSpriteId(widget, spriteId);
        this.widgets.revalidate(widget);
        return widget;
    }
}

function removeTags(text: string): string {
    return text.replace(/<[^>]*>/g, "");
}

/** RuneLite's QuantityFormatter.quantityToStackSize: 1234 -> "1234", 123456 -> "123K", 12345678 -> "12M". */
export function quantityToStackSize(quantity: number): string {
    if (quantity < 0) return `-${quantityToStackSize(-quantity)}`;
    if (quantity < 100_000) return String(quantity);
    if (quantity < 10_000_000) return `${Math.floor(quantity / 1000)}K`;
    return `${Math.floor(quantity / 1_000_000)}M`;
}
