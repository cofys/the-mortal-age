import * as pako from "pako";

import { MinimapImageRenderer } from "../../rs/map/MinimapImageRenderer";
import { Scene } from "../../rs/scene/Scene";
import { crc32 } from "../../rs/util/Crc32";

export type MinimapData = { mapX: number; mapY: number; minimapBlobs: Blob[] };

function pngChunk(type: string, bytes: Uint8Array) {
    const chunk = new Uint8Array(bytes.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, bytes.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(bytes, 8);
    view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
    return chunk;
}

export async function loadMinimapBlob(
    minimapImageRenderer: MinimapImageRenderer,
    scene: Scene,
    level: number,
    borderSize: number,
): Promise<Blob> {
    const minimapPixels = minimapImageRenderer.renderMinimap(scene, level);

    const width = (scene.sizeX - borderSize * 2) * 4;
    const height = (scene.sizeY - borderSize * 2) * 4;
    const stride = width * 3 + 1;
    const rows = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        let source = (y + borderSize * 4) * scene.sizeX * 4 + borderSize * 4;
        let target = y * stride + 1; // PNG filter 0; minimaps are opaque RGB.
        for (let x = 0; x < width; x++) {
            const pixel = minimapPixels[source++];
            rows[target++] = pixel >>> 16;
            rows[target++] = pixel >>> 8;
            rows[target++] = pixel;
        }
    }

    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 2; // 8-bit RGB, with the same fully opaque pixels as the canvas path.
    // Encode directly: convertToBlob can wait several seconds for browser idle time.
    return new Blob([
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", pako.deflate(rows)),
        pngChunk("IEND", new Uint8Array()),
    ], { type: "image/png" });
}
