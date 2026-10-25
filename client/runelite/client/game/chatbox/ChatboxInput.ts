/**
 * RuneLite's ChatboxInput: something shown in the chatbox's message layer by
 * ChatboxPanelManager. `open` builds it into the container; `close` runs once when it goes.
 */
export abstract class ChatboxInput {
    /** Builds the input into ChatboxPanelManager.getContainerWidget(). */
    abstract open(): void;

    /** The input has been closed (by itself, another input, script 299 or logging out). */
    abstract close(): void;
}

/**
 * RuneLite's KeyListener, for a chatbox input: `keyTyped` for a printable character and
 * `keyPressed` for every key. Each returns true when it consumed the key, so the game doesn't
 * see it.
 */
export interface ChatboxKeyListener {
    keyTyped?(event: ChatboxKeyEvent): boolean;
    keyPressed?(event: ChatboxKeyEvent): boolean;
}

/** RuneLite's MouseListener, in canvas pixels. */
export interface ChatboxMouseListener {
    mousePressed?(event: ChatboxMouseEvent): void;
    mouseDragged?(event: ChatboxMouseEvent): void;
}

/** A key, as Java's KeyEvent describes it: `key` is the browser's key name, `char` a typed one. */
export type ChatboxKeyEvent = {
    key: string;
    char?: string;
    ctrl: boolean;
    shift: boolean;
};

export type ChatboxMouseEvent = { x: number; y: number; button: number; shift: boolean };

export function isKeyListener(input: unknown): input is ChatboxKeyListener {
    const i = input as ChatboxKeyListener;
    return typeof i?.keyTyped === "function" || typeof i?.keyPressed === "function";
}

export function isMouseListener(input: unknown): input is ChatboxMouseListener {
    const i = input as ChatboxMouseListener;
    return typeof i?.mousePressed === "function" || typeof i?.mouseDragged === "function";
}
