import { MESLAYERINPUT, MESLAYERMODE } from "@runelite/api/gameval/VarClientID";
import { WidgetTextAlignment, WidgetType } from "../../../widgets/custom/dynamicWidgets";
import type { WidgetNode } from "../../../widgets/WidgetNode";
import type { WidgetActionEvent } from "../../widgets/widgetActionPayload";
import type { BankTagsClient } from "../banktags/bankClient";
import { SOUND_UI_BOOP } from "../banktags/bankmain";
import { BankWidgets } from "../banktags/bankWidgets";

/** InterfaceID.Chatbox.MES_LAYER and MES_TEXT2 (162:39, 162:44). */
const MES_LAYER = (162 << 16) | 39;
const MES_TEXT2 = (162 << 16) | 44;
/** The chatbox search box's script finished loading (QuestBankTab's SEARCHBOX_LOADED). */
export const SEARCHBOX_LOADED = 750;
/** MESLAYERMODE's Grand Exchange item search. */
const MODE_GE_SEARCH = 14;
const QUEST_BANK_TAG = "quest-helper";
const VIEW_TAB = "View missing items ";
const MAX_RESULT_COUNT = 250;
/** The Grand Exchange's centre: the button shows within 20 tiles of it. */
const GE = { x: 3164, y: 3489, plane: 0 };
const Sprite = { UNKNOWN_BUTTON_SQUARE_SMALL: 195, UNKNOWN_BUTTON_SQUARE_SMALL_SELECTED: 196, BLUE_QUESTS: 835 } as const;
/** FontID.BOLD_12, JagexColors.CHAT_GAME_EXAMINE_TEXT_OPAQUE_BACKGROUND. */
const FONT_BOLD_12 = 496;
const TITLE_COLOR = 0x000000;

/** What the Grand Exchange search reads of Quest Helper. */
export interface QuestGrandExchangeHost {
    selectedQuestName(): string | null;
    solvePuzzles(): boolean;
    /** The active step's QuestStep.getGeInterfaceIcon. */
    stepItems(): number[] | undefined;
    /** QuestHelperBankTagService.itemsToTag: the quest's missing items. */
    missingItems(): number[] | undefined;
    playerLocation(): { x: number; y: number; plane: number } | undefined;
}

/**
 * Upstream QuestGrandExchangeInterface and QuestBankTab.onGrandExchangeSearched: at the Grand
 * Exchange a "View missing items" button by the item search lists the quest's missing items; away
 * from it, a step that names items to buy (a puzzle's ingredients, say) shows them at once.
 */
export class QuestHelperGrandExchange {
    active = false;
    private questBackgroundWidget?: WidgetNode;
    private questIconWidget?: WidgetNode;
    private grandExchangeTitle?: WidgetNode;
    private readonly widgets: BankWidgets;

    constructor(
        private readonly client: BankTagsClient,
        private readonly host: QuestGrandExchangeHost,
    ) {
        this.widgets = new BankWidgets(() => client.widgets);
    }

    isHidden(): boolean {
        const widget = this.client.getWidget(MES_LAYER);
        return !widget || this.widgets.isHidden(widget);
    }

    notAtGE(): boolean {
        const p = this.host.playerLocation();
        // WorldPoint.distanceTo: the larger axis distance, or "far" on another plane.
        return !p || p.plane !== GE.plane || Math.max(Math.abs(p.x - GE.x), Math.abs(p.y - GE.y)) > 20;
    }

    /** ScriptPostFired(SEARCHBOX_LOADED). */
    init(): void {
        if (this.isHidden() || this.host.selectedQuestName() === null) return;
        const parent = this.client.getWidget(MES_LAYER)!;
        if (this.notAtGE()) {
            if (this.host.solvePuzzles() && this.host.stepItems()) this.onceOffActivateTab(parent);
            return;
        }
        const SIZE = 20;
        const X = 480;
        const Y = 0;
        const background = this.createGraphic(parent, "quest helper", Sprite.UNKNOWN_BUTTON_SQUARE_SMALL, SIZE, SIZE, X, Y);
        this.widgets.setAction(background, 1, VIEW_TAB);
        this.widgets.listen(background, { onOp: (_event: WidgetActionEvent) => this.handleTagTab() });
        this.questBackgroundWidget = background;
        this.questIconWidget = this.createGraphic(parent, "", Sprite.BLUE_QUESTS, SIZE - 6, SIZE - 6, X + 3, Y + 3);
        this.grandExchangeTitle = this.createTitle(parent, `<col=b40000>${this.host.selectedQuestName()}</col> required items`, !this.active);
        if (this.active) {
            this.active = false;
            this.activateTab();
        }
    }

    destroy(): void {
        if (this.active) this.closeOptions();
        for (const w of [this.questIconWidget, this.questBackgroundWidget, this.grandExchangeTitle]) if (w) this.widgets.setHidden(w, true);
        this.questIconWidget = this.questBackgroundWidget = this.grandExchangeTitle = undefined;
        this.active = false;
    }

    private handleTagTab(): void {
        if (this.active) this.closeOptions();
        else this.activateTab();
        this.client.playSoundEffect(SOUND_UI_BOOP);
    }

    private closeOptions(): void {
        this.active = false;
        if (this.questBackgroundWidget) {
            this.widgets.setSpriteId(this.questBackgroundWidget, Sprite.UNKNOWN_BUTTON_SQUARE_SMALL);
            this.widgets.revalidate(this.questBackgroundWidget);
        }
        if (this.grandExchangeTitle) this.widgets.setHidden(this.grandExchangeTitle, true);
        this.client.setVarcStrValue(MESLAYERINPUT, "");
        this.client.setVarcIntValue(MESLAYERMODE, MODE_GE_SEARCH);
        queueMicrotask(() => this.updateSearchInterface(false));
    }

    private activateTab(): void {
        if (this.active || !this.questBackgroundWidget) return;
        this.widgets.setSpriteId(this.questBackgroundWidget, Sprite.UNKNOWN_BUTTON_SQUARE_SMALL_SELECTED);
        this.widgets.revalidate(this.questBackgroundWidget);
        if (this.grandExchangeTitle) this.widgets.setHidden(this.grandExchangeTitle, false);
        this.active = true;
        this.client.setVarcStrValue(MESLAYERINPUT, QUEST_BANK_TAG);
        this.client.setVarcIntValue(MESLAYERMODE, MODE_GE_SEARCH);
        queueMicrotask(() => this.updateSearchInterface(true));
    }

    /** Away from the Grand Exchange (a shop-like buy interface): the step's items, at once. */
    private onceOffActivateTab(parent: WidgetNode): void {
        this.createTitle(parent, "<col=b40000>Quest Helper</col> Items", false);
        this.client.setVarcStrValue(MESLAYERINPUT, QUEST_BANK_TAG);
        this.client.setVarcIntValue(MESLAYERMODE, MODE_GE_SEARCH);
        queueMicrotask(() => this.updateSearchInterface(true));
    }

    /** Runs the search box's key listener (which searches), and hides the box. */
    private updateSearchInterface(hideSearchBox: boolean): void {
        const box = this.client.getWidget(MES_TEXT2);
        if (!box) return;
        const w = box as any;
        if (!w.eventHandlers?.onKey && !(Array.isArray(w.onKey) && w.onKey.length)) return;
        this.client.runListener(box, "onKey");
        this.widgets.setHidden(box, hideSearchBox);
    }

    /**
     * GrandExchangeSearched: a search for "quest-helper" lists the quest's missing tradeable
     * items at the Grand Exchange, or the step's items elsewhere. Returns the results to show, or
     * undefined to leave the search to the game.
     */
    searchResults(input: string, isTradeable: (id: number) => boolean): number[] | undefined {
        if (input !== QUEST_BANK_TAG || this.host.selectedQuestName() === null) return undefined;
        if (this.notAtGE()) return this.host.stepItems() ?? [];
        const ids = new Set<number>();
        for (const id of this.host.missingItems() ?? []) {
            if (ids.size >= MAX_RESULT_COUNT) break;
            if (isTradeable(id)) ids.add(id);
        }
        return [...ids].sort((a, b) => a - b);
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

    private createTitle(container: WidgetNode, text: string, hidden: boolean): WidgetNode {
        const widget = this.widgets.createChild(container, WidgetType.TEXT);
        const chatbox = this.client.getWidget(MES_TEXT2);
        if (!chatbox) return widget;
        this.widgets.setOriginalWidth(widget, this.widgets.width(chatbox));
        this.widgets.setOriginalHeight(widget, this.widgets.height(chatbox));
        this.widgets.setOriginalX(widget, 0);
        this.widgets.setOriginalY(widget, 0);
        (widget as any).textShadowed = widget.textShadow = false;
        widget.xTextAlignment = WidgetTextAlignment.CENTER;
        widget.yTextAlignment = WidgetTextAlignment.CENTER;
        this.widgets.setText(widget, text);
        widget.fontId = FONT_BOLD_12;
        widget.textColor = widget.color = TITLE_COLOR;
        if (hidden) this.widgets.setHidden(widget, true);
        this.widgets.revalidate(widget);
        return widget;
    }
}
