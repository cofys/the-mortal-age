/** Java's InputEvent modifier masks, as RuneLite's Keybind stores them. */
export const SHIFT_DOWN_MASK = 64;
export const CTRL_DOWN_MASK = 128;
export const META_DOWN_MASK = 256;
export const ALT_DOWN_MASK = 512;

/** Java's KeyEvent codes for the modifier keys; the browser's keyCode uses the same numbers. */
const MODIFIER_KEYS: Record<number, number> = {
    16: SHIFT_DOWN_MASK,
    17: CTRL_DOWN_MASK,
    18: ALT_DOWN_MASK,
    91: META_DOWN_MASK,
    93: META_DOWN_MASK,
    224: META_DOWN_MASK,
};

/** Java's KeyEvent.VK_UNDEFINED: a keybind of modifiers alone. */
export const VK_UNDEFINED = 0;

/**
 * RuneLite's Keybind: a key code (Java's KeyEvent, which for letters, digits and most keys is the
 * browser's keyCode) and a modifier mask. Stored as "keyCode:modifiers"; Keybind.ALT is "0:512".
 */
export class Keybind {
    static readonly NOT_SET = new Keybind(VK_UNDEFINED, 0);
    static readonly CTRL = new Keybind(VK_UNDEFINED, CTRL_DOWN_MASK);
    static readonly ALT = new Keybind(VK_UNDEFINED, ALT_DOWN_MASK);
    static readonly SHIFT = new Keybind(VK_UNDEFINED, SHIFT_DOWN_MASK);

    constructor(readonly keyCode: number, readonly modifiers: number) {
        // A modifier key on its own is stored as just its modifier, as RuneLite does.
        const mask = MODIFIER_KEYS[keyCode];
        if (mask !== undefined) {
            this.keyCode = VK_UNDEFINED;
            this.modifiers = modifiers | mask;
        }
    }

    static parse(raw: string | undefined | null, fallback: Keybind = Keybind.NOT_SET): Keybind {
        const match = /^(\d+):(\d+)$/.exec(String(raw ?? "").trim());
        return match ? new Keybind(Number(match[1]), Number(match[2])) : fallback;
    }

    /** The modifiers held for a browser key event, as Java's getModifiersEx. */
    static modifiersOf(event: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): number {
        return (event.shiftKey ? SHIFT_DOWN_MASK : 0) | (event.ctrlKey ? CTRL_DOWN_MASK : 0)
            | (event.altKey ? ALT_DOWN_MASK : 0) | (event.metaKey ? META_DOWN_MASK : 0);
    }

    /** The keybind a key press makes (RuneLite's HotkeyButton). */
    static fromEvent(event: { keyCode: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): Keybind {
        return new Keybind(event.keyCode, Keybind.modifiersOf(event));
    }

    toString(): string {
        return `${this.keyCode}:${this.modifiers}`;
    }

    equals(other: Keybind): boolean {
        return other.keyCode === this.keyCode && other.modifiers === this.modifiers;
    }

    /**
     * RuneLite's Keybind.matches for a key press: the key and the modifiers held. For a keybind of
     * modifiers alone, pressing its last modifier key with the others held.
     */
    matches(event: { keyCode: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
        if (this.equals(Keybind.NOT_SET)) return false;
        const pressed = Keybind.fromEvent(event);
        if (this.keyCode !== VK_UNDEFINED) return pressed.keyCode === this.keyCode && pressed.modifiers === this.modifiers;
        return pressed.keyCode === VK_UNDEFINED && pressed.modifiers === this.modifiers;
    }

    /** Whether releasing this key ends the keybind (its key, or one of its modifier keys). */
    releasedBy(event: { keyCode: number }): boolean {
        if (this.equals(Keybind.NOT_SET)) return false;
        if (this.keyCode !== VK_UNDEFINED) return event.keyCode === this.keyCode;
        const mask = MODIFIER_KEYS[event.keyCode];
        return mask !== undefined && (this.modifiers & mask) !== 0;
    }

    /** How the settings panel shows it, e.g. "Alt" or "Ctrl+X". */
    describe(): string {
        if (this.equals(Keybind.NOT_SET)) return "Not set";
        const parts: string[] = [];
        if (this.modifiers & CTRL_DOWN_MASK) parts.push("Ctrl");
        if (this.modifiers & ALT_DOWN_MASK) parts.push("Alt");
        if (this.modifiers & SHIFT_DOWN_MASK) parts.push("Shift");
        if (this.modifiers & META_DOWN_MASK) parts.push("Meta");
        if (this.keyCode !== VK_UNDEFINED) {
            const code = this.keyCode;
            const name = (code >= 48 && code <= 90) ? String.fromCharCode(code)
                : (code >= 112 && code <= 123) ? `F${code - 111}` : `Key ${code}`;
            parts.push(name);
        }
        return parts.join("+");
    }
}
