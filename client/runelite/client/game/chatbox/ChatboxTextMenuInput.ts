// RuneLite's FontID.QUILL_8 is font 497 (q8_full), which ui/fonts names FONT_FANCY_8.
import { FONT_FANCY_8 as FONT_QUILL_8 } from "../../../../ui/fonts";
import {
    WidgetPositionMode,
    WidgetSizeMode,
    WidgetTextAlignment,
    WidgetType,
    createChild,
    revalidate,
    setAction,
    setTextColor,
} from "../../../../widgets/custom/dynamicWidgets";
import type { WidgetNode } from "../../../../widgets/WidgetNode";
import { ChatboxInput, type ChatboxKeyEvent, type ChatboxKeyListener } from "./ChatboxInput";
import type { ChatboxPanelManager } from "./ChatboxPanelManager";

type Entry = { text: string; callback: () => void };

/**
 * RuneLite's ChatboxTextMenuInput: a title and a list of options in the chatbox, picked by
 * clicking one or pressing its number; Escape closes it.
 */
export class ChatboxTextMenuInput extends ChatboxInput implements ChatboxKeyListener {
    private titleText?: string;
    private readonly options: Entry[] = [];
    private onCloseCallback?: () => void;

    constructor(private readonly chatboxPanelManager: ChatboxPanelManager) {
        super();
    }

    getTitle(): string | undefined {
        return this.titleText;
    }

    getOptions(): readonly Entry[] {
        return this.options;
    }

    title(title: string): this {
        this.titleText = title;
        return this;
    }

    option(text: string, callback: () => void): this {
        this.options.push({ text, callback });
        return this;
    }

    onClose(onClose: () => void): this {
        this.onCloseCallback = onClose;
        return this;
    }

    build(): this {
        if (this.titleText === undefined) throw new Error("Title must be set");
        if (this.options.length < 1) throw new Error("You must have atleast 1 option");
        this.chatboxPanelManager.openInput(this);
        return this;
    }

    open(): void {
        const widgets = this.chatboxPanelManager.getWidgetManager();
        const container = this.chatboxPanelManager.getContainerWidget();
        if (!container) return;
        const prompt = this.text(container, this.titleText ?? "");
        prompt.textColor = prompt.color = 0x800000;
        prompt.rawY = 8;
        revalidate(widgets, prompt);
        widgets.ensureLayout(prompt);

        // RuneLite starts from the prompt's relative x (0, as it is centred at full width).
        let y = (prompt.x | 0) + (prompt.height | 0) + 6;
        const height = (container.height | 0) - y - 8;
        let step = Math.trunc(height / this.options.length);
        const maxStep = this.options.length >= 3 ? 25 : 30;
        if (step > maxStep) {
            const ds = step - maxStep;
            step = maxStep;
            y += Math.trunc((ds * this.options.length) / 2);
        }
        for (const option of this.options) {
            const optWidget = this.text(container, option.text);
            optWidget.rawY = y;
            setAction(optWidget, 0, "Continue");
            (optWidget as any).jsListeners = {
                onOp: () => this.callback(option),
                onMouseOver: () => setTextColor(widgets, optWidget, 0xffffff),
                onMouseLeave: () => setTextColor(widgets, optWidget, 0),
            };
            revalidate(widgets, optWidget);
            y += step;
        }
    }

    /** A centred QUILL_8 text line at full width, 24 high (RuneLite's prompt and option widgets). */
    private text(container: WidgetNode, text: string): WidgetNode {
        const widget = createChild(this.chatboxPanelManager.getWidgetManager(), container, WidgetType.TEXT);
        widget.text = text;
        widget.fontId = FONT_QUILL_8;
        widget.xPositionMode = WidgetPositionMode.ABSOLUTE_CENTER;
        widget.rawX = 0;
        widget.yPositionMode = WidgetPositionMode.ABSOLUTE_TOP;
        widget.rawHeight = 24;
        widget.xTextAlignment = WidgetTextAlignment.CENTER;
        widget.yTextAlignment = WidgetTextAlignment.CENTER;
        widget.widthMode = WidgetSizeMode.MINUS;
        return widget;
    }

    private callback(entry: Entry): void {
        this.chatboxPanelManager.close();
        entry.callback();
    }

    close(): void {
        this.onCloseCallback?.();
    }

    keyTyped(event: ChatboxKeyEvent): boolean {
        if (!this.chatboxPanelManager.shouldTakeInput()) return false;
        const n = (event.char ?? "").charCodeAt(0) - "1".charCodeAt(0);
        if (event.char?.length === 1 && n >= 0 && n < this.options.length) {
            this.callback(this.options[n]);
            return true;
        }
        return false;
    }

    keyPressed(event: ChatboxKeyEvent): boolean {
        if (!this.chatboxPanelManager.shouldTakeInput()) return false;
        if (event.key === "Escape") {
            // Java delivers Escape to keyTyped as '\033'; the browser has no typed event for it.
            this.chatboxPanelManager.close();
            return true;
        }
        return false;
    }
}
