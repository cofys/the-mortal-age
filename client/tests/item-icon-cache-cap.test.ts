import assert from "node:assert/strict";

import type { CacheIndex } from "../rs/cache/CacheIndex";
import { ItemIconRenderer } from "../ui/item/ItemIconRenderer";
import type { GLRenderer } from "../widgets/gl/renderer";
import { TextureCache } from "../widgets/gl/texture-cache";

// Item icons are keyed by quantity: a bank or shop stack that keeps changing made a new GL
// texture and sprite canvas for every count, and none was ever freed.

const textures = new Map<string, { tex: object; w: number; h: number }>();
const deleted: string[] = [];
const glr = {
    textures,
    getTexture: (key: string) => textures.get(key),
    createTextureFromCanvas: (key: string, canvas: { width: number; height: number }) => {
        const tex = { tex: {}, w: canvas.width, h: canvas.height };
        textures.set(key, tex);
        return tex;
    },
    deleteTexture: (key: string) => {
        deleted.push(key);
        return textures.delete(key);
    },
} as unknown as GLRenderer;
const canvas = { width: 36, height: 32 } as HTMLCanvasElement;
const cache = new TextureCache(glr, {} as CacheIndex, () => canvas);

const inventoryIcon = cache.getItemIconById(946, 1);
for (let qty = 1; qty <= 3000; qty++) {
    cache.getItemIconById(1517, qty);
    // Drawn every frame, so it stays among the most recent.
    assert.equal(cache.getItemIconById(946, 1), inventoryIcon, "a drawn icon is reused");
}
assert.equal(textures.size, 2048, "item icon textures are capped");
assert.ok(textures.has("item:946:1:0:0:2"), "the icon drawn every frame is kept");
assert.ok(!textures.has("item:1517:2:0:0:1"), "old stack counts are evicted");
assert.ok(textures.has("item:1517:3000:0:0:1"), "the newest stack count is kept");
assert.ok(deleted.every((key) => key.startsWith("item:1517:")), "evicted textures are deleted from GL");

// The software sprite cache behind it is capped the same way.
const renderer = Object.create(ItemIconRenderer.prototype) as any;
renderer.itemSpriteCache = new Map();
for (let i = 0; i < 3000; i++) {
    renderer.cacheItemSprite(BigInt(i), { pixels: new Int32Array(0), isStackable: true });
}
assert.equal(renderer.itemSpriteCache.size, 2048, "item sprite cache is capped");
assert.ok(!renderer.itemSpriteCache.has(0n), "oldest sprite is evicted");
assert.ok(renderer.itemSpriteCache.has(2999n), "newest sprite is kept");

console.log("item-icon-cache-cap: ok");
