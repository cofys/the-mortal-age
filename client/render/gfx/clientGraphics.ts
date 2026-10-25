import type { TypeLoader } from "../../rs/config/TypeLoader";

/**
 * A graphic made by the client rather than the cache (RuneLite's RuneLiteObject, for the cases
 * a spot animation covers): a model, recoloured, animated and lit like a cache spot anim. The
 * Gfx path lights spot anims at ambient + 64 and contrast + 850.
 */
export type ClientSpotAnim = {
    modelId: number;
    sequenceId: number;
    recolorFrom?: number[];
    recolorTo?: number[];
    ambient?: number;
    contrast?: number;
};

/** Ids above any cache spot anim. */
const FIRST_CLIENT_SPOT_ID = 1_000_000;
const registry = new Map<number, object>();
const byKey = new Map<string, number>();
let nextId = FIRST_CLIENT_SPOT_ID;

/** Registers (once per distinct definition) a client spot anim; the same definition gets the same id. */
export function registerClientSpotAnim(def: ClientSpotAnim): number {
    const key = JSON.stringify(def);
    const known = byKey.get(key);
    if (known !== undefined) return known;
    const id = nextId++;
    registry.set(id, {
        id,
        modelId: def.modelId,
        sequenceId: def.sequenceId,
        recolorFrom: def.recolorFrom ?? [],
        recolorTo: def.recolorTo ?? [],
        retextureFrom: undefined,
        retextureTo: undefined,
        widthScale: 128,
        heightScale: 128,
        orientation: 0,
        ambient: def.ambient ?? 0,
        contrast: def.contrast ?? 0,
    });
    byKey.set(key, id);
    return id;
}

export function isClientSpotAnim(id: number): boolean {
    return registry.has(id);
}

/** The spot anim loader, answering client spot anims first. */
export function withClientSpotAnims<T>(loader: TypeLoader<T>): TypeLoader<T> {
    return {
        load: (id: number) => (registry.get(id) as T | undefined) ?? loader.load(id),
        getCount: () => loader.getCount(),
        clearCache: () => loader.clearCache(),
    };
}

/** java.awt.Color.RGBtoHSB. */
function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
    const cmax = Math.max(r, g, b);
    const cmin = Math.min(r, g, b);
    const brightness = cmax / 255;
    const saturation = cmax !== 0 ? (cmax - cmin) / cmax : 0;
    let hue = 0;
    if (saturation !== 0) {
        const redc = (cmax - r) / (cmax - cmin);
        const greenc = (cmax - g) / (cmax - cmin);
        const bluec = (cmax - b) / (cmax - cmin);
        if (r === cmax) hue = bluec - greenc;
        else if (g === cmax) hue = 2 + redc - bluec;
        else hue = 4 + greenc - redc;
        hue /= 6;
        if (hue < 0) hue += 1;
    }
    return [hue, saturation, brightness];
}

export const JAGEX_LUMINANCE_MAX = 127;

/** JagexColor.packHSL. */
export function packHsl(hue: number, saturation: number, luminance: number): number {
    return ((hue & 63) << 10) | ((saturation & 7) << 7) | (luminance & 127);
}

/** JagexColor.rgbToHSL: a 24-bit colour as a 16-bit model colour. */
export function rgbToHsl(rgb: number, brightness = 1): number {
    if (rgb === 1) return 0;
    const exponent = 1 / brightness;
    const r = Math.pow(((rgb >> 16) & 255) / 256, exponent);
    const g = Math.pow(((rgb >> 8) & 255) / 256, exponent);
    const b = Math.pow((rgb & 255) / 256, exponent);
    const [h, s, v] = rgbToHsb(Math.trunc(r * 256), Math.trunc(g * 256), Math.trunc(b * 256));
    const luminance = v - (v * s) / 2;
    const saturation = (v - luminance) / Math.min(luminance, 1 - luminance);
    return packHsl(Math.ceil(h * 64) % 63, Math.ceil(saturation * 7), Math.ceil(luminance * 127));
}
