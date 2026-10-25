import { GameState } from "../../../api/GameState";
import type { GameStateChanged } from "../../../api/events";
import { MESLAYERMODE, WORLDMAP_SEARCHING } from "../../../api/gameval/VarClientID";
import type { BitmapFont } from "../../../../rs/font/BitmapFont";
import { createSharedFontLoader, type FontLoader } from "../../../../widgets/gl/sharedFontLoader";
import { deleteAllChildren, setHidden } from "../../../../widgets/custom/dynamicWidgets";
import type { WidgetManager } from "../../../../widgets/WidgetManager";
import type { WidgetNode } from "../../../../widgets/WidgetNode";
import {
    ChatboxInput,
    isKeyListener,
    isMouseListener,
    type ChatboxKeyEvent,
    type ChatboxMouseEvent,
} from "./ChatboxInput";
import { ChatboxTextInput } from "./ChatboxTextInput";
import { ChatboxTextMenuInput } from "./ChatboxTextMenuInput";

/** ScriptID.MESSAGE_LAYER_CLOSE: (0, 1, 0) closes the message layer. */
export const MESSAGE_LAYER_CLOSE = 299;
/** ScriptID.MESSAGE_LAYER_OPEN: readies the message layer for a chatbox input. */
export const MESSAGE_LAYER_OPEN = 677;
/** InputType.RUNELITE_CHATBOX_PANEL, for varc MESLAYERMODE. */
export const RUNELITE_CHATBOX_PANEL = -3;
/** InterfaceID.Chatbox.MES_LAYER, MES_TEXT and MES_TEXT2 (162:39, 162:43, 162:44). */
export const CHATBOX_MES_LAYER = (162 << 16) | 39;
export const CHATBOX_MES_TEXT = (162 << 16) | 43;
export const CHATBOX_MES_TEXT2 = (162 << 16) | 44;

/** What the panel manager uses of the client. */
export type ChatboxClient = {
    widgetManager: WidgetManager;
    cs2Vm: { scriptPreListeners: Set<(id: number, event: any) => void> };
    varManager: { setVarcInt(id: number, value: number): void; getVarcInt(id: number): number };
    inputManager: {
        mouseX: number;
        mouseY: number;
        addKeyHandler(handler: { onKeyDown?(event: KeyboardEvent): boolean }): () => void;
        addMouseHandler(handler: { onMouseDown?(event: MouseEvent): void; onMouseMove?(event: MouseEvent): void }): () => void;
    };
    runClientScriptWithInts(scriptId: number, args: number[]): void;
    cacheSystem?: unknown;
};

/**
 * RuneLite's ChatboxPanelManager: shows one ChatboxInput at a time in the chatbox's message
 * layer, the way the game shows its own prompts there.
 *
 * RuneLite runs the open and close scripts on the client thread with invokeLater; here they
 * run on the next client tick, since a script started from inside another script would reset
 * the VM's stacks.
 */
export class ChatboxPanelManager {
    private currentInput?: ChatboxInput;
    private readonly later: (() => void)[] = [];
    private readonly fontLoader: FontLoader;
    private readonly unsubscribe: (() => void)[] = [];
    private dragging = false;
    /** The VM the script listener is on (the client builds its VM after RuneLite starts). */
    private listeningVm?: ChatboxClient["cs2Vm"];
    private readonly onScript = (id: number) => this.onScriptPreFired(id);
    private inputAttached = false;
    /** Set while there is something to do each client tick (nothing is posted otherwise). */
    private tickSubscription?: () => void;

    /**
     * `subscribeTicks` runs a function every client tick until the returned function is called;
     * without it, the owner calls onClientTick.
     */
    constructor(
        private readonly client: ChatboxClient,
        fontLoader?: FontLoader,
        private readonly subscribeTicks?: (tick: () => void) => () => void,
    ) {
        this.fontLoader = fontLoader ?? createSharedFontLoader(() => client.cacheSystem as any);
    }

    /** KeyManager / MouseManager registration, on first use (the client builds its input later). */
    private attachInput(): void {
        if (this.inputAttached || !this.client.inputManager) return;
        this.inputAttached = true;
        this.unsubscribe.push(this.client.inputManager.addKeyHandler({ onKeyDown: (event) => this.onKeyDown(event) }));
        this.unsubscribe.push(this.client.inputManager.addMouseHandler({
            onMouseDown: (event) => this.onMouseDown(event),
            onMouseMove: (event) => this.onMouseMove(event),
        }));
    }

    dispose(): void {
        for (const off of this.unsubscribe.splice(0)) off();
        this.tickSubscription?.();
        this.tickSubscription = undefined;
        this.inputAttached = false;
        this.listeningVm?.scriptPreListeners.delete(this.onScript);
        this.listeningVm = undefined;
    }

    /** ScriptPreFired: listens on the client's current VM. */
    private listenForScripts(): void {
        const vm = this.client.cs2Vm;
        if (!vm || vm === this.listeningVm) return;
        this.listeningVm?.scriptPreListeners.delete(this.onScript);
        vm.scriptPreListeners.add(this.onScript);
        this.listeningVm = vm;
    }

    getCurrentInput(): ChatboxInput | undefined {
        return this.currentInput;
    }

    /** ClientThread.invokeLater: runs on the next client tick. */
    invokeLater(fn: () => void): void {
        this.later.push(fn);
        if (!this.tickSubscription && this.subscribeTicks) this.tickSubscription = this.subscribeTicks(() => this.onClientTick());
    }

    close(): void {
        this.invokeLater(() => this.unsafeCloseInput());
    }

    openInput(input: ChatboxInput): void {
        this.invokeLater(() => this.unsafeOpenInput(input));
    }

    openTextMenuInput(title: string): ChatboxTextMenuInput {
        return new ChatboxTextMenuInput(this).title(title);
    }

    openTextInput(prompt: string): ChatboxTextInput {
        return new ChatboxTextInput(this).prompt(prompt);
    }

    getWidgetManager(): WidgetManager {
        return this.client.widgetManager;
    }

    getFont(fontId: number): BitmapFont | undefined {
        return this.fontLoader(fontId);
    }

    /** The message layer the input builds into, laid out. */
    getContainerWidget(): WidgetNode | undefined {
        const widgets = this.client.widgetManager;
        widgets.getGroup?.(162);
        const container = widgets.getWidgetByUid(CHATBOX_MES_LAYER) ?? undefined;
        if (container) widgets.ensureLayout(container);
        return container;
    }

    /** Typing goes to the world map's search box while it has focus (varc WORLDMAP_SEARCHING). */
    shouldTakeInput(): boolean {
        return this.client.varManager.getVarcInt(WORLDMAP_SEARCHING) !== 1;
    }

    mouseX(): number {
        return this.client.inputManager.mouseX;
    }

    mouseY(): number {
        return this.client.inputManager.mouseY;
    }

    onClientTick(): void {
        for (const fn of this.later.splice(0)) {
            try {
                fn();
            } catch (error) {
                console.warn("[chatbox] panel update failed", error);
            }
        }
        (this.currentInput as { tick?: () => void } | undefined)?.tick?.();
        if (!this.currentInput && this.later.length === 0 && this.tickSubscription) {
            this.tickSubscription();
            this.tickSubscription = undefined;
        }
    }

    onGameStateChanged(event: GameStateChanged): void {
        if (this.currentInput && event.getGameState() === GameState.LOGIN_SCREEN) this.killCurrentPanel();
    }

    private unsafeCloseInput(): void {
        this.client.runClientScriptWithInts(MESSAGE_LAYER_CLOSE, [0, 1, 0]);
        if (this.currentInput) this.killCurrentPanel();
    }

    private unsafeOpenInput(input: ChatboxInput): void {
        this.listenForScripts();
        this.attachInput();
        this.client.runClientScriptWithInts(MESSAGE_LAYER_OPEN, [0]);
        if (this.currentInput) this.killCurrentPanel();
        this.currentInput = input;
        this.client.varManager.setVarcInt(MESLAYERMODE, RUNELITE_CHATBOX_PANEL);
        const widgets = this.client.widgetManager;
        for (const uid of [CHATBOX_MES_TEXT, CHATBOX_MES_TEXT2]) {
            const w = widgets.getWidgetByUid(uid);
            if (w) setHidden(widgets, w, true);
        }
        const container = this.getContainerWidget();
        if (!container) return;
        deleteAllChildren(widgets, container);
        input.open();
    }

    private onScriptPreFired(id: number): void {
        if (this.currentInput && id === MESSAGE_LAYER_CLOSE) this.killCurrentPanel();
    }

    private killCurrentPanel(): void {
        const input = this.currentInput;
        this.currentInput = undefined;
        this.dragging = false;
        try {
            input?.close();
        } catch (error) {
            console.warn("[chatbox] closing input failed", error);
        }
    }

    // ------------------------------------------------------------------ input

    private onKeyDown(event: KeyboardEvent): boolean {
        const input = this.currentInput;
        if (!input || !isKeyListener(input)) return false;
        const key: ChatboxKeyEvent = {
            key: event.key,
            char: event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key : undefined,
            ctrl: event.ctrlKey || event.metaKey,
            shift: event.shiftKey,
        };
        let consumed = input.keyPressed?.(key) === true;
        if (key.char !== undefined && this.currentInput === input) consumed = input.keyTyped?.(key) === true || consumed;
        return consumed;
    }

    private mouseEvent(event: MouseEvent): ChatboxMouseEvent {
        return { x: this.client.inputManager.mouseX, y: this.client.inputManager.mouseY, button: event.button, shift: event.shiftKey };
    }

    private onMouseDown(event: MouseEvent): void {
        const input = this.currentInput;
        this.dragging = event.button === 0;
        if (input && isMouseListener(input)) input.mousePressed?.(this.mouseEvent(event));
    }

    private onMouseMove(event: MouseEvent): void {
        const input = this.currentInput;
        if ((event.buttons & 1) === 0) this.dragging = false;
        if (this.dragging && input && isMouseListener(input)) input.mouseDragged?.(this.mouseEvent(event));
    }
}
