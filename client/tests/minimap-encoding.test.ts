import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

import { loadMinimapBlob } from "../game/worker/MinimapData";
import { crc32 } from "../rs/util/Crc32";

test("minimap PNGs retain exact colors, dimensions and border cropping without a canvas", async () => {
    for (const border of [0, 1]) {
        const scene = { sizeX: 3, sizeY: 4 };
        const pixels = Int32Array.from({ length: 12 * 16 }, (_, i) => (i << 16) | (i << 8) | (255 - i));
        const original = pixels.slice();
        const renderer = { renderMinimap(s: unknown, level: number) {
            assert.equal(s, scene);
            assert.equal(level, 1);
            return pixels;
        } };
        const blob = await loadMinimapBlob(renderer as any, scene as any, 1, border);
        assert.equal(blob.type, "image/png");
        const bytes = Buffer.from(await blob.arrayBuffer());
        assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        const compressed: Buffer[] = [];
        const types: string[] = [];
        const width = (scene.sizeX - border * 2) * 4, height = (scene.sizeY - border * 2) * 4;
        for (let at = 8; at < bytes.length;) {
            const size = bytes.readUInt32BE(at), type = bytes.toString("ascii", at + 4, at + 8);
            const data = bytes.subarray(at + 8, at + 8 + size);
            assert.equal(bytes.readUInt32BE(at + 8 + size), crc32(bytes.subarray(at + 4, at + 8 + size)));
            types.push(type);
            if (type === "IHDR") {
                assert.equal(data.readUInt32BE(0), width);
                assert.equal(data.readUInt32BE(4), height);
                assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]);
            }
            if (type === "IDAT") compressed.push(data);
            at += size + 12;
        }
        assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
        const raw = inflateSync(Buffer.concat(compressed));
        assert.equal(raw.length, height * (width * 3 + 1));
        for (let y = 0; y < height; y++) {
            let at = y * (width * 3 + 1);
            assert.equal(raw[at++], 0);
            for (let x = 0; x < width; x++) {
                const pixel = original[(y + border * 4) * 12 + x + border * 4];
                assert.deepEqual([...raw.subarray(at, at + 3)], [pixel >>> 16 & 255, pixel >>> 8 & 255, pixel & 255]);
                at += 3;
            }
        }
        assert.deepEqual(pixels, original);
        assert.deepEqual(Buffer.from(await (await loadMinimapBlob(renderer as any, scene as any, 1, border)).arrayBuffer()), bytes);
    }
});
