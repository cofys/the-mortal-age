import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import type { CacheSystem } from "../rs/cache/CacheSystem";
import { BitmapFont } from "../rs/font/BitmapFont";
import { getBitmapFontAtlas } from "../ui/text/BitmapFontAtlas";
import type { GLRenderer } from "../widgets/gl/renderer";
import { createSharedFontLoader } from "../widgets/gl/sharedFontLoader";

// #559: widget draw paths asked for a font loader every frame, each loader made new
// BitmapFonts, and each new font left a GL atlas texture behind in GLRenderer.textures.

// Every loader call shares one font per id; a swapped cache system starts over.
let loads = 0;
let cacheSystem = {} as CacheSystem;
const loader = createSharedFontLoader(
    () => cacheSystem,
    () => {
        loads++;
        return new BitmapFont();
    },
);
const font = loader(495);
assert.equal(loader(495), font, "same font for the same id");
assert.equal(loads, 1, "the font is loaded once");
cacheSystem = {} as CacheSystem;
assert.notEqual(loader(495), font, "a new cache system loads the font again");

// Atlas textures are freed once their font is collected.
(globalThis as any).document = {
    createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: () => {},
        }),
    }),
};
const textures = new Map<string, unknown>();
const glr = {
    createTextureFromCanvas: (key: string, canvas: { width: number; height: number }) => {
        const tex = { tex: {}, w: canvas.width, h: canvas.height };
        textures.set(key, tex);
        return tex;
    },
    deleteTexture: (key: string) => textures.delete(key),
} as unknown as GLRenderer;

const kept = new BitmapFont();
getBitmapFontAtlas(glr, kept);
for (let i = 0; i < 20; i++) getBitmapFontAtlas(glr, new BitmapFont());
assert.equal(textures.size, 21, "one atlas texture per font");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

void (async () => {
    for (let i = 0; i < 20 && textures.size > 1; i++) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(textures.size, 1, "only the live font keeps its atlas texture");
    assert.equal(getBitmapFontAtlas(glr, kept).texture, [...textures.values()][0], "live atlas is reused");
    console.log("font-atlas-leak: ok");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
