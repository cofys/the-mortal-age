import type { CacheIndex } from "../../../rs/cache/CacheIndex";
import type { CacheSystem } from "../../../rs/cache/CacheSystem";
import { IndexType } from "../../../rs/cache/IndexType";
import { BitmapFont } from "../../../rs/font/BitmapFont";
import { IndexedSprite } from "../../../rs/sprite/IndexedSprite";

export function getSpritesIndex(cacheSystem: CacheSystem | undefined): CacheIndex | undefined {
    if (!cacheSystem) return undefined;
    try {
        return cacheSystem.getIndex(IndexType.DAT2.sprites);
    } catch {
        return undefined;
    }
}

export function tryLoadFont(cacheSystem: CacheSystem | undefined, fontIds: number[]): BitmapFont | undefined {
    if (!cacheSystem) return undefined;
    for (const id of fontIds) {
        try {
            const font = BitmapFont.tryLoad(cacheSystem, id);
            if (font) return font;
        } catch {}
    }
    return undefined;
}

export function indexedSpriteToPixels(sprite: IndexedSprite): {
    pixels: Uint8Array;
    width: number;
    height: number;
} {
    const width = Math.max(1, (sprite.subWidth | 0) || 1);
    const height = Math.max(1, (sprite.subHeight | 0) || 1);
    const pixels = new Uint8Array(width * height * 4);
    const palette = sprite.palette ?? new Int32Array([0xffffff]);
    const src = sprite.pixels ?? new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const idx = src[i] & 0xff;
        if (idx === 0) continue;
        const color = palette[idx] ?? 0;
        const di = i * 4;
        pixels[di] = (color >> 16) & 0xff;
        pixels[di + 1] = (color >> 8) & 0xff;
        pixels[di + 2] = color & 0xff;
        pixels[di + 3] = sprite.alpha?.[i] ?? 0xff;
    }
    return { pixels, width, height };
}

/** Port of OverheadTextOverlay.spriteToCanvas: palette + offsets into a 2D canvas. */
export function indexedSpriteToCanvas(sprite: IndexedSprite): HTMLCanvasElement {
    const width = sprite.width || sprite.subWidth;
    const height = sprite.height || sprite.subHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext("2d", {
        willReadFrequently: true as never,
    }) as CanvasRenderingContext2D | null;
    if (!ctx) return canvas;
    const img = ctx.createImageData(canvas.width, canvas.height);
    const palette = sprite.palette;
    const pixels = sprite.pixels;
    const subWidth = sprite.subWidth;
    const subHeight = sprite.subHeight;
    const ox = sprite.xOffset | 0;
    const oy = sprite.yOffset | 0;
    for (let y = 0; y < subHeight; y++) {
        for (let x = 0; x < subWidth; x++) {
            const srcIdx = x + y * subWidth;
            const palIndex = pixels[srcIdx] & 0xff;
            if (palIndex === 0) continue;
            const dx = x + ox;
            const dy = y + oy;
            if (dx < 0 || dy < 0 || dx >= canvas.width || dy >= canvas.height) continue;
            const di = (dx + dy * canvas.width) * 4;
            const rgb = palette[palIndex];
            img.data[di] = (rgb >> 16) & 0xff;
            img.data[di + 1] = (rgb >> 8) & 0xff;
            img.data[di + 2] = rgb & 0xff;
            img.data[di + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

export function createTextCanvas(width: number, height: number): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
} | undefined {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext("2d", {
        willReadFrequently: true as never,
    }) as CanvasRenderingContext2D | null;
    if (!ctx) return undefined;
    return { canvas, ctx };
}

export function cssColor(color: number): string {
    return `#${(color >>> 0).toString(16).padStart(6, "0")}`;
}
