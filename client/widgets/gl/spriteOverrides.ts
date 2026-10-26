/**
 * RuneLite's SpriteManager.addSpriteOverrides: images a plugin draws in place of a sprite id,
 * typically a negative id the cache doesn't have (Bank Tags' tab backgrounds are -201 to -205).
 * A graphic widget whose spriteId has an override draws the image as it would draw the sprite.
 */
type Override = { url: string; canvas?: HTMLCanvasElement; version: number };

const overrides = new Map<number, Override>();
const listeners = new Set<() => void>();
let nextVersion = 1;

export function hasSpriteOverride(id: number): boolean {
    return overrides.get(id)?.canvas !== undefined;
}

/** The loaded image for `id`, and a version that changes when it does (for texture keys). */
export function getSpriteOverride(id: number): { canvas: HTMLCanvasElement; version: number } | undefined {
    const o = overrides.get(id);
    return o?.canvas ? { canvas: o.canvas, version: o.version } : undefined;
}

/** Calls `listener` whenever an override image finishes loading or is removed. */
export function onSpriteOverridesChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function addSpriteOverride(id: number, url: string): void {
    if (overrides.get(id)?.url === url) return;
    const entry: Override = { url, version: nextVersion++ };
    overrides.set(id, entry);
    if (typeof Image === "undefined" || typeof document === "undefined") return;
    const image = new Image();
    image.onload = () => {
        if (overrides.get(id) !== entry) return;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
        entry.canvas = canvas;
        notify();
    };
    image.onerror = () => console.warn(`[sprites] couldn't load the override for sprite ${id}: ${url}`);
    image.src = url;
}

export function removeSpriteOverride(id: number): void {
    if (overrides.delete(id)) notify();
}

function notify(): void {
    for (const listener of listeners) listener();
}
