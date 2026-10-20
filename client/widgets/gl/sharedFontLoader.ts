import { BitmapFont } from "../../rs/font/BitmapFont";
import type { CacheSystem } from "../../rs/cache/CacheSystem";

export type FontLoader = (id: number) => BitmapFont | undefined;

/**
 * One BitmapFont per font id for every caller. Some widget draw paths ask for a loader each
 * frame, and each new BitmapFont gets its own GL atlas texture (#559), so the cache must
 * outlive the loader calls. It resets when the cache system is swapped.
 */
export function createSharedFontLoader(
    getCacheSystem: () => CacheSystem | undefined,
    load: (cacheSystem: CacheSystem, id: number) => BitmapFont | undefined = (cacheSystem, id) =>
        BitmapFont.tryLoad(cacheSystem, id),
): FontLoader {
    const fonts = new Map<number, BitmapFont>();
    let fontsFrom: CacheSystem | undefined;
    return (id: number) => {
        const cacheSystem = getCacheSystem();
        if (!cacheSystem) return undefined;
        if (cacheSystem !== fontsFrom) {
            fonts.clear();
            fontsFrom = cacheSystem;
        }
        const key = id | 0;
        const cached = fonts.get(key);
        if (cached) return cached;
        const font = load(cacheSystem, key);
        // Do not memoize missing fonts forever. During startup the widget overlay
        // can probe a font before the cache data is fully ready, and a permanent
        // cached undefined would make all later CS2 text for that font invisible.
        if (font) fonts.set(key, font);
        return font;
    };
}
