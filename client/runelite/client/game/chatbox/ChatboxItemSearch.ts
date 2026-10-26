import {
    WidgetPositionMode,
    WidgetSizeMode,
    WidgetTextAlignment,
    WidgetType,
    createChild,
    deleteAllChildren,
    revalidate,
    setAction,
} from "../../../../widgets/custom/dynamicWidgets";
import type { ChatboxKeyEvent } from "./ChatboxInput";
import type { ChatboxPanelManager } from "./ChatboxPanelManager";
import { ChatboxTextInput } from "./ChatboxTextInput";

const ICON_HEIGHT = 32;
const ICON_WIDTH = 36;
const PADDING = 6;
const MAX_RESULTS = 24;
const FONT_SIZE = 16;
const HOVERED_OPACITY = 128;
/** WidgetType.LINE. */
const LINE = 9;
/** JagexColors.MENU_TARGET_TAG. */
const MENU_TARGET_TAG = "<col=ff9040>";

/** What the search reads of an item: RuneLite's ItemComposition fields it uses. */
export type SearchableItem = {
    id: number;
    name: string;
    inventoryModel?: number;
    ambient?: number;
    contrast?: number;
    recolorTo?: readonly number[];
    retextureTo?: readonly number[];
};

export type ChatboxItemSource = {
    getItemCount(): number;
    /** The canonical item (RuneLite's itemManager.getItemComposition(itemManager.canonicalize(id))). */
    getCanonicalItem(id: number): SearchableItem | undefined;
};

/**
 * RuneLite's ChatboxItemSearch: a one-line item name search in the chatbox, showing up to 24
 * matching items (one per distinct icon). Clicking a result, or Enter on the one picked with
 * Tab/arrows, calls onItemSelected and closes the input.
 */
export class ChatboxItemSearch extends ChatboxTextInput {
    private readonly results = new Map<number, SearchableItem>();
    private tooltip = "";
    private index = -1;
    private onItemSelectedCallback?: (itemId: number) => void;

    constructor(
        private readonly panelManager: ChatboxPanelManager,
        private readonly items: ChatboxItemSource,
    ) {
        super(panelManager);
        this.lines(1);
        this.prompt("Item Search");
        this.onChanged(() =>
            panelManager.invokeLater(() => {
                this.filterResults();
                this.update();
            }),
        );
    }

    onItemSelected(onItemSelected: (itemId: number) => void): this {
        this.onItemSelectedCallback = onItemSelected;
        return this;
    }

    tooltipText(text: string): this {
        this.tooltip = text;
        return this;
    }

    /** Deprecated in RuneLite: the item search has no done value. */
    override onDone(): this {
        throw new Error("ChatboxItemSearch has no onDone; use onItemSelected");
    }

    protected override update(): void {
        const widgets = this.panelManager.getWidgetManager();
        const container = this.panelManager.getContainerWidget();
        if (!container) return;
        deleteAllChildren(widgets, container);

        const promptWidget = createChild(widgets, container, WidgetType.TEXT);
        promptWidget.text = this.getPrompt() ?? "";
        promptWidget.textColor = promptWidget.color = 0x800000;
        promptWidget.fontId = this.getFontId();
        promptWidget.rawX = 0;
        promptWidget.rawY = 5;
        promptWidget.xPositionMode = WidgetPositionMode.ABSOLUTE_CENTER;
        promptWidget.yPositionMode = WidgetPositionMode.ABSOLUTE_TOP;
        promptWidget.rawHeight = FONT_SIZE;
        promptWidget.xTextAlignment = WidgetTextAlignment.CENTER;
        promptWidget.yTextAlignment = WidgetTextAlignment.CENTER;
        promptWidget.widthMode = WidgetSizeMode.MINUS;
        revalidate(widgets, promptWidget);

        this.buildEdit(container, 0, 5 + FONT_SIZE, container.width | 0, FONT_SIZE);

        const separator = createChild(widgets, container, LINE);
        separator.rawX = 0;
        separator.rawY = 8 + FONT_SIZE * 2;
        separator.xPositionMode = WidgetPositionMode.ABSOLUTE_CENTER;
        separator.yPositionMode = WidgetPositionMode.ABSOLUTE_TOP;
        separator.rawHeight = 0;
        separator.rawWidth = 16;
        separator.widthMode = WidgetSizeMode.MINUS;
        separator.textColor = separator.color = 0x666666;
        revalidate(widgets, separator);

        let x = PADDING;
        let y = PADDING * 3;
        let idx = 0;
        for (const result of this.results.values()) {
            const item = createChild(widgets, container, WidgetType.GRAPHIC);
            item.xPositionMode = WidgetPositionMode.ABSOLUTE_LEFT;
            item.yPositionMode = WidgetPositionMode.ABSOLUTE_TOP;
            item.rawX = x;
            item.rawY = y + FONT_SIZE * 2;
            item.rawHeight = ICON_HEIGHT;
            item.rawWidth = ICON_WIDTH;
            (item as any).name = (item as any).opBase = MENU_TARGET_TAG + result.name;
            item.itemId = result.id;
            item.itemQuantity = 10000;
            (item as any).itemQuantityMode = 0;
            (item as any).borderType = 1;
            setAction(item, 0, this.tooltip);

            const setOpacity = (opacity: number) => {
                item.transparency = opacity;
                widgets.invalidateWidgetRender(item);
            };
            if (this.index === idx) item.transparency = HOVERED_OPACITY;
            const select = () => {
                this.onItemSelectedCallback?.(result.id);
                this.panelManager.close();
            };
            (item as any).jsListeners =
                this.index === idx
                    ? { onOp: select }
                    : { onOp: select, onMouseOver: () => setOpacity(HOVERED_OPACITY), onMouseLeave: () => setOpacity(0) };

            x += ICON_WIDTH + PADDING;
            if (x + ICON_WIDTH >= (container.width | 0)) {
                y += ICON_HEIGHT + PADDING;
                x = PADDING;
            }
            revalidate(widgets, item);
            ++idx;
        }
    }

    override keyPressed(event: ChatboxKeyEvent): boolean {
        if (!this.panelManager.shouldTakeInput()) return false;
        const size = this.results.size;
        switch (event.key) {
            case "Enter":
                if (this.index > -1) {
                    this.onItemSelectedCallback?.([...this.results.keys()][this.index]);
                    this.panelManager.close();
                }
                return true;
            case "Tab":
            case "ArrowRight":
                if (size > 0) {
                    this.index = this.index + 1 >= size ? 0 : this.index + 1;
                    this.panelManager.invokeLater(() => this.update());
                }
                return true;
            case "ArrowLeft":
                if (size > 0) {
                    this.index = this.index - 1 < 0 ? size - 1 : this.index - 1;
                    this.panelManager.invokeLater(() => this.update());
                }
                return true;
            case "ArrowUp":
                if (size >= MAX_RESULTS / 2) {
                    this.index -= MAX_RESULTS / 2;
                    if (this.index < 0) {
                        this.index += size === MAX_RESULTS ? size : MAX_RESULTS;
                        this.index = Math.min(Math.max(this.index, 0), size - 1);
                    }
                    this.panelManager.invokeLater(() => this.update());
                }
                return true;
            case "ArrowDown":
                if (size >= MAX_RESULTS / 2) {
                    this.index += MAX_RESULTS / 2;
                    if (this.index >= MAX_RESULTS) {
                        this.index -= size === MAX_RESULTS ? size : MAX_RESULTS;
                        this.index = Math.min(Math.max(this.index, 0), size - 1);
                    }
                    this.panelManager.invokeLater(() => this.update());
                }
                return true;
            default:
                return super.keyPressed(event);
        }
    }

    override close(): void {
        // Clear the search when closed.
        this.value("");
        this.results.clear();
        this.index = -1;
        super.close();
    }

    private filterResults(): void {
        this.results.clear();
        this.index = -1;
        const search = this.getValue().toLowerCase();
        if (!search) return;

        const icons = new Set<string>();
        const count = this.items.getItemCount();
        for (let i = 0; i < count && this.results.size < MAX_RESULTS; i++) {
            const item = this.items.getCanonicalItem(i);
            if (!item) continue;
            const name = item.name.toLowerCase();
            // The client names items it doesn't know "null"; canonicalize can repeat an item.
            if (name === "null" || !name.includes(search) || this.results.has(item.id)) continue;
            // One result per distinct item image.
            const icon = JSON.stringify([item.inventoryModel, item.ambient, item.contrast, item.recolorTo, item.retextureTo]);
            if (icons.has(icon)) continue;
            icons.add(icon);
            this.results.set(item.id, item);
        }
    }
}
