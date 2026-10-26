// RuneLite's FontID.QUILL_8 is font 497 (q8_full), which ui/fonts names FONT_FANCY_8.
import { FONT_FANCY_8 as FONT_QUILL_8 } from "../../../../ui/fonts";
import {
    WidgetPositionMode,
    WidgetSizeMode,
    WidgetTextAlignment,
    WidgetType,
    canvasBounds,
    createChild,
    deleteAllChildren,
    revalidate,
} from "../../../../widgets/custom/dynamicWidgets";
import type { WidgetNode } from "../../../../widgets/WidgetNode";
import {
    ChatboxInput,
    type ChatboxKeyEvent,
    type ChatboxKeyListener,
    type ChatboxMouseEvent,
    type ChatboxMouseListener,
} from "./ChatboxInput";
import type { ChatboxPanelManager } from "./ChatboxPanelManager";

const CURSOR_FLASH_RATE_MILLIS = 1000;
const BREAK_MATCHER = /[^a-zA-Z0-9']/;

type Line = { start: number; end: number; text: string };
type Point = { x: number; y: number };

const defaultCharValidator = (c: number) => c >= 32 && c < 127;

/** Text.escapeJagex: < and > as the <lt> and <gt> tags. */
function escapeJagex(text: string): string {
    return text.replace(/[<>]/g, (c) => (c === "<" ? "<lt>" : "<gt>"));
}

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

/**
 * RuneLite's ChatboxTextInput: a prompt over an editable value in the chatbox, with a blinking
 * cursor, word wrap over `lines` lines, selection by Shift + arrows or the mouse, and Ctrl+A/C/X/V.
 * Enter calls onDone (which may keep the input open), Escape closes it.
 */
export class ChatboxTextInput extends ChatboxInput implements ChatboxKeyListener, ChatboxMouseListener {
    private promptText?: string;
    private lineCount = 0;
    private text = "";
    private cursorStart = 0;
    private cursorEnd = 0;
    private selectionStart = -1;
    private selectionEnd = -1;
    private charValidatorFn: (c: number) => boolean = defaultCharValidator;
    private onCloseCallback?: () => void;
    private onDoneCallback?: (value: string) => boolean;
    private onChangedCallback?: (value: string) => void;
    private fontId = FONT_QUILL_8;
    private built = false;
    private cursor?: WidgetNode;
    private cursorBornAt = 0;
    private isInBounds?: (event: Point) => boolean;
    private getLineOffset?: (key: string) => number;
    private getPointCharOffset?: (point: Point) => number;

    constructor(private readonly chatboxPanelManager: ChatboxPanelManager) {
        super();
    }

    addCharValidator(validator: (c: number) => boolean): this {
        const previous = this.charValidatorFn;
        this.charValidatorFn = (c) => previous(c) && validator(c);
        return this;
    }

    lines(lines: number): this {
        this.lineCount = lines;
        if (this.built) this.chatboxPanelManager.invokeLater(() => this.update());
        return this;
    }

    prompt(prompt: string): this {
        this.promptText = prompt;
        if (this.built) this.chatboxPanelManager.invokeLater(() => this.update());
        return this;
    }

    getPrompt(): string | undefined {
        return this.promptText;
    }

    value(value: string): this {
        let v = "";
        for (const c of value) if (this.charValidatorFn(c.charCodeAt(0))) v += c;
        this.text = v;
        this.cursorAt(this.text.length);
        return this;
    }

    getValue(): string {
        return this.text;
    }

    getCursorStart(): number {
        return this.cursorStart;
    }

    getCursorEnd(): number {
        return this.cursorEnd;
    }

    cursorAt(indexA: number, indexB: number = indexA): this {
        indexA = clamp(indexA, 0, this.text.length);
        indexB = clamp(indexB, 0, this.text.length);
        this.cursorStart = Math.min(indexA, indexB);
        this.cursorEnd = Math.max(indexA, indexB);
        if (this.built) this.update();
        return this;
    }

    charValidator(validator: ((c: number) => boolean) | null): this {
        this.charValidatorFn = validator ?? defaultCharValidator;
        return this;
    }

    onClose(onClose: () => void): this {
        this.onCloseCallback = onClose;
        return this;
    }

    /** Called with the value on Enter; return false to keep the input open. */
    onDone(onDone: ((value: string) => boolean) | ((value: string) => void)): this {
        this.onDoneCallback = (value) => onDone(value) !== false;
        return this;
    }

    onChanged(onChanged: (value: string) => void): this {
        this.onChangedCallback = onChanged;
        return this;
    }

    font(fontId: number): this {
        this.fontId = fontId;
        return this;
    }

    /** RuneLite's getFontID. */
    protected getFontId(): number {
        return this.fontId;
    }

    build(): this {
        if (this.promptText === undefined) throw new Error("prompt must be non-null");
        this.chatboxPanelManager.openInput(this);
        return this;
    }

    open(): void {
        this.built = true;
        this.cursorBornAt = Date.now();
        this.update();
    }

    close(): void {
        this.built = false;
        this.onCloseCallback?.();
    }

    /** The cursor's flash (RuneLite's onTimer listener on the cursor). */
    tick(): void {
        const cursor = this.cursor;
        if (!cursor) return;
        const on = (Date.now() - this.cursorBornAt) % CURSOR_FLASH_RATE_MILLIS > CURSOR_FLASH_RATE_MILLIS / 2;
        const transparency = on ? 0 : 255;
        if (cursor.transparency !== transparency) {
            cursor.transparency = transparency;
            this.chatboxPanelManager.getWidgetManager().invalidateWidgetRender(cursor);
        }
    }

    protected update(): void {
        const widgets = this.chatboxPanelManager.getWidgetManager();
        const container = this.chatboxPanelManager.getContainerWidget();
        if (!container) return;
        deleteAllChildren(widgets, container);
        const promptWidget = createChild(widgets, container, WidgetType.TEXT);
        promptWidget.text = this.promptText ?? "";
        promptWidget.textColor = promptWidget.color = 0x800000;
        promptWidget.fontId = this.fontId;
        promptWidget.xPositionMode = WidgetPositionMode.ABSOLUTE_CENTER;
        promptWidget.rawX = 0;
        promptWidget.yPositionMode = WidgetPositionMode.ABSOLUTE_TOP;
        promptWidget.rawY = 8;
        promptWidget.rawHeight = 24;
        promptWidget.xTextAlignment = WidgetTextAlignment.CENTER;
        promptWidget.yTextAlignment = WidgetTextAlignment.CENTER;
        promptWidget.widthMode = WidgetSizeMode.MINUS;
        revalidate(widgets, promptWidget);
        this.buildEdit(container, 0, 50, container.width | 0, 0);
    }

    protected buildEdit(container: WidgetNode, x: number, y: number, w: number, h: number): void {
        const widgets = this.chatboxPanelManager.getWidgetManager();
        const editLines: Line[] = [];
        const cursor = createChild(widgets, container, WidgetType.RECTANGLE);
        this.cursor = cursor;
        cursor.textColor = cursor.color = 0xffffff;
        cursor.filled = true;
        cursor.fontId = this.fontId;
        const font = this.chatboxPanelManager.getFont(this.fontId);
        const width = (s: string) => (font ? font.measure(s) : s.length * 6);
        if (h <= 0) h = font?.ascent || 12;
        const oy = y, ox = x, oh = h;

        let breakIndex = -1;
        let sb = "";
        const value = this.text;
        for (let i = 0; i < value.length; i++) {
            const count = i - sb.length;
            const c = value.charAt(i);
            sb += c;
            if (BREAK_MATCHER.test(c)) breakIndex = sb.length;
            if (i === value.length - 1) {
                editLines.push({ start: count, end: count + sb.length - 1, text: sb });
                break;
            }
            if (width(sb + value.charAt(i + 1)) < w) continue;
            if (editLines.length < this.lineCount - 1 || this.lineCount === 0) {
                if (breakIndex > 1) {
                    const str = sb.substring(0, breakIndex);
                    editLines.push({ start: count, end: count + str.length - 1, text: str });
                    sb = sb.substring(breakIndex);
                    breakIndex = -1;
                    continue;
                }
                editLines.push({ start: count, end: count + sb.length - 1, text: sb });
                sb = "";
            }
        }

        // RuneLite starts the bounds at the container's right edge in canvas x; x is shrunk to the
        // leftmost line below. Widths here are in widget pixels.
        const bounds = { x: (container.width | 0), y, width: 0, height: editLines.length * oh };
        const text = (str: string, tx: number, color?: number) => {
            const t = createChild(widgets, container, WidgetType.TEXT);
            t.fontId = this.fontId;
            t.text = escapeJagex(str);
            t.rawX = tx;
            t.rawY = y;
            t.rawWidth = width(str);
            t.rawHeight = h;
            if (color !== undefined) t.textColor = t.color = color;
            revalidate(widgets, t);
        };
        for (let i = 0; i < editLines.length || i === 0; i++) {
            const line = editLines.length > 0 ? editLines[i] : { start: 0, end: 0, text: "" };
            const lineText = line.text;
            const len = lineText.length;
            let lt = lineText, mt = "", rt = "";
            const isStartLine = this.cursorOnLine(this.cursorStart, line.start, line.end)
                || (this.cursorOnLine(this.cursorStart, line.start, line.end + 1) && i === editLines.length - 1);
            const isEndLine = this.cursorOnLine(this.cursorEnd, line.start, line.end);
            if (isStartLine || isEndLine || (this.cursorEnd > line.end && this.cursorStart < line.start)) {
                const cIdx = clamp(this.cursorStart - line.start, 0, len);
                const ceIdx = clamp(this.cursorEnd - line.start, 0, len);
                lt = lineText.substring(0, cIdx);
                mt = lineText.substring(cIdx, ceIdx);
                rt = lineText.substring(ceIdx);
            }
            const ltw = width(lt), mtw = width(mt), rtw = width(rt);
            const fullWidth = ltw + mtw + rtw;
            let ltx = ox;
            if (w > 0) ltx += Math.trunc((w - fullWidth) / 2);
            const mtx = ltx + ltw;
            const rtx = mtx + mtw;
            if (ltx < bounds.x) bounds.x = ltx;
            if (fullWidth > bounds.width) bounds.width = fullWidth;
            if (editLines.length === 0 || isStartLine) {
                cursor.rawX = mtx - 1;
                cursor.rawY = y;
                cursor.rawWidth = 2;
                cursor.rawHeight = h;
                revalidate(widgets, cursor);
            }
            if (lt) text(lt, ltx);
            if (mt) {
                const background = createChild(widgets, container, WidgetType.RECTANGLE);
                background.textColor = background.color = 0x113399;
                background.filled = true;
                background.rawX = mtx - 1;
                background.rawY = y;
                background.rawWidth = 2 + mtw;
                background.rawHeight = h;
                revalidate(widgets, background);
                text(mt, mtx, 0xffffff);
            }
            if (rt) text(rt, rtx);
            y += h;
        }

        // Mouse points are in canvas pixels; the container's last drawn position maps them back.
        const toLocal = (p: Point): Point | undefined => {
            const at = canvasBounds(container);
            if (!at) return undefined;
            return { x: (p.x - at.x) / at.scaleX, y: (p.y - at.y) / at.scaleY };
        };
        this.isInBounds = (p) => {
            const l = toLocal(p);
            return !!l && l.x >= bounds.x && l.x < bounds.x + bounds.width && l.y >= bounds.y && l.y < bounds.y + bounds.height;
        };
        const charOffsetAt = (cx: number, cy: number): number => {
            if (bounds.width <= 0) return 0;
            cx -= ox;
            cy -= oy;
            const currentLine = clamp(Math.trunc(cy / oh), 0, editLines.length - 1);
            const line = editLines[currentLine];
            const tsValue = line.text;
            let charIndex = tsValue.length;
            const fullWidth = width(tsValue);
            let tx = ox;
            if (w > 0) tx += Math.trunc((w - fullWidth) / 2);
            cx -= tx;
            for (let i = tsValue.length; i >= 0 && charIndex >= 0 && charIndex <= tsValue.length; i--) {
                const lcx = charIndex > 0 ? width(tsValue.substring(0, charIndex - 1)) : 0;
                const mcx = width(tsValue.substring(0, charIndex));
                const rcx = charIndex + 1 <= tsValue.length ? width(tsValue.substring(0, charIndex + 1)) : mcx;
                const leftBound = Math.trunc((lcx + mcx) / 2);
                const rightBound = Math.trunc((mcx + rcx) / 2);
                if (cx < leftBound) {
                    charIndex--;
                    continue;
                }
                if (cx > rightBound) {
                    charIndex++;
                    continue;
                }
                break;
            }
            return line.start + clamp(charIndex, 0, tsValue.length);
        };
        this.getPointCharOffset = (p) => {
            const l = toLocal(p);
            return l ? charOffsetAt(l.x, l.y) : 0;
        };
        this.getLineOffset = (key) => {
            if (editLines.length < 2) return this.cursorStart;
            let currentLine = -1;
            for (let i = 0; i < editLines.length; i++) {
                const l = editLines[i];
                if (this.cursorOnLine(this.cursorStart, l.start, l.end)
                    || (this.cursorOnLine(this.cursorStart, l.start, l.end + 1) && i === editLines.length - 1)) {
                    currentLine = i;
                    break;
                }
            }
            if (currentLine === -1
                || (key === "ArrowUp" && currentLine === 0)
                || (key === "ArrowDown" && currentLine === editLines.length - 1)) {
                return this.cursorStart;
            }
            const line = editLines[currentLine];
            const direction = key === "ArrowUp" ? -1 : 1;
            const charOffset = charOffsetAt((cursor.rawX ?? 0) | 0, ((cursor.rawY ?? 0) | 0) + direction * oh);
            const nextLine = editLines[currentLine + direction];
            if ((direction === -1 && charOffset >= line.start)
                || (direction === 1 && charOffset > nextLine.end && currentLine + direction !== editLines.length - 1)) {
                return nextLine.end;
            }
            return charOffset;
        };
    }

    private cursorOnLine(cursor: number, start: number, end: number): boolean {
        return cursor >= start && cursor <= end;
    }

    private changed(): void {
        this.onChangedCallback?.(this.text);
    }

    private deleteSelection(): void {
        this.text = this.text.slice(0, this.cursorStart) + this.text.slice(this.cursorEnd);
    }

    keyTyped(event: ChatboxKeyEvent): boolean {
        if (!this.chatboxPanelManager.shouldTakeInput() || event.char === undefined) return false;
        const c = event.char.charCodeAt(0);
        if (this.charValidatorFn(c)) {
            if (this.cursorStart !== this.cursorEnd) this.deleteSelection();
            this.text = this.text.slice(0, this.cursorStart) + event.char + this.text.slice(this.cursorStart);
            this.cursorAt(this.cursorStart + 1);
            this.changed();
        }
        // The browser would also hand the character to the game's chat line.
        return true;
    }

    keyPressed(event: ChatboxKeyEvent): boolean {
        if (!this.chatboxPanelManager.shouldTakeInput()) return false;
        const key = event.key;
        if (event.ctrl) {
            switch (key.toLowerCase()) {
                case "x":
                case "c":
                    if (this.cursorStart !== this.cursorEnd) {
                        const s = this.text.substring(this.cursorStart, this.cursorEnd);
                        if (key.toLowerCase() === "x") {
                            this.deleteSelection();
                            this.cursorAt(this.cursorStart);
                        }
                        void navigator.clipboard?.writeText(s).catch((error) => console.warn("[chatbox] Unable to set clipboard", error));
                    }
                    return true;
                case "v":
                    void this.paste();
                    return true;
                case "a":
                    this.selectionStart = 0;
                    this.selectionEnd = this.text.length;
                    this.cursorAt(0, this.selectionEnd);
                    return true;
            }
            return false;
        }

        let newPos = this.cursorStart;
        if (event.shift) {
            if (this.selectionEnd === -1 || this.selectionStart === -1) {
                this.selectionStart = this.cursorStart;
                this.selectionEnd = this.cursorStart;
            }
            newPos = this.selectionEnd;
        } else {
            this.selectionStart = -1;
            this.selectionEnd = -1;
        }

        switch (key) {
            case "Delete":
                if (this.cursorStart !== this.cursorEnd) {
                    this.deleteSelection();
                    this.cursorAt(this.cursorStart);
                    this.changed();
                    return true;
                }
                if (this.cursorStart < this.text.length) {
                    this.text = this.text.slice(0, this.cursorStart) + this.text.slice(this.cursorStart + 1);
                    this.cursorAt(this.cursorStart);
                    this.changed();
                }
                return true;
            case "Backspace":
                if (this.cursorStart !== this.cursorEnd) {
                    this.deleteSelection();
                    this.cursorAt(this.cursorStart);
                    this.changed();
                    return true;
                }
                if (this.cursorStart > 0) {
                    this.text = this.text.slice(0, this.cursorStart - 1) + this.text.slice(this.cursorStart);
                    this.cursorAt(this.cursorStart - 1);
                    this.changed();
                }
                return true;
            case "ArrowLeft":
                newPos = this.cursorStart !== this.cursorEnd ? this.cursorStart : newPos - 1;
                break;
            case "ArrowRight":
                newPos = this.cursorStart !== this.cursorEnd ? this.cursorEnd : newPos + 1;
                break;
            case "ArrowUp":
            case "ArrowDown":
                newPos = this.getLineOffset?.(key) ?? this.cursorStart;
                break;
            case "Home":
                newPos = 0;
                break;
            case "End":
                newPos = this.text.length;
                break;
            case "Enter":
                if (this.onDoneCallback && !this.onDoneCallback(this.text)) return true;
                this.chatboxPanelManager.close();
                return true;
            case "Escape":
                if (this.cursorStart !== this.cursorEnd) {
                    this.cursorAt(this.cursorStart);
                    return true;
                }
                this.chatboxPanelManager.close();
                return true;
            default:
                return false;
        }
        newPos = clamp(newPos, 0, this.text.length);
        if (event.shift) {
            this.selectionEnd = newPos;
            this.cursorAt(this.selectionStart, newPos);
        } else {
            this.cursorAt(newPos);
        }
        return true;
    }

    private async paste(): Promise<void> {
        let s: string;
        try {
            s = await navigator.clipboard.readText();
        } catch (error) {
            console.warn("[chatbox] Unable to get clipboard", error);
            return;
        }
        if (!this.built) return;
        if (this.cursorStart !== this.cursorEnd) this.deleteSelection();
        let at = this.cursorStart;
        for (const ch of s) {
            if (this.charValidatorFn(ch.charCodeAt(0))) {
                this.text = this.text.slice(0, at) + ch + this.text.slice(at);
                at++;
            }
        }
        this.cursorAt(at);
        this.changed();
    }

    mousePressed(event: ChatboxMouseEvent): void {
        if (event.button !== 0) return;
        const point = { x: event.x, y: event.y };
        if (!this.isInBounds || !this.isInBounds(point)) {
            if (this.cursorStart !== this.cursorEnd) {
                this.selectionStart = -1;
                this.selectionEnd = -1;
                this.cursorAt(this.getPointCharOffset?.(point) ?? 0);
            }
            return;
        }
        const nco = this.getPointCharOffset?.(point) ?? 0;
        if (event.shift && this.selectionEnd !== -1) {
            this.selectionEnd = nco;
            this.cursorAt(this.selectionStart, this.selectionEnd);
        } else {
            this.selectionStart = nco;
            this.cursorAt(nco);
        }
    }

    mouseDragged(event: ChatboxMouseEvent): void {
        const nco = this.getPointCharOffset?.({ x: event.x, y: event.y }) ?? 0;
        if (this.selectionStart !== -1) {
            this.selectionEnd = nco;
            this.cursorAt(this.selectionStart, this.selectionEnd);
        }
    }
}
