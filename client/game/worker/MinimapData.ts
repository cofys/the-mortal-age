import { MinimapImageRenderer } from "../../rs/map/MinimapImageRenderer";
import { Scene } from "../../rs/scene/Scene";

export type MinimapData = { mapX: number; mapY: number; minimapBlobs: Blob[] };

export async function loadMinimapBlob(
    minimapImageRenderer: MinimapImageRenderer,
    scene: Scene,
    level: number,
    borderSize: number,
): Promise<Blob> {
    const minimapPixels = minimapImageRenderer.renderMinimap(scene, level);

    const minimapView = new DataView(minimapPixels.buffer);
    for (let i = 0; i < minimapPixels.length; i++) {
        minimapView.setUint32(i * 4, (minimapPixels[i] << 8) | 0xff);
    }

    const widthExclBorder = (scene.sizeX - borderSize * 2) * 4;
    const heightExclBorder = (scene.sizeY - borderSize * 2) * 4;
    const canvas = new OffscreenCanvas(widthExclBorder, heightExclBorder);
    const contextOptions: CanvasRenderingContext2DSettings = { willReadFrequently: true };
    const ctx = canvas.getContext("2d", contextOptions);
    if (!ctx) {
        throw new Error("Could not get canvas context");
    }

    const pixelWidth = scene.sizeX * 4;
    const pixelHeight = scene.sizeY * 4;
    const imageData = new ImageData(pixelWidth, pixelHeight);
    imageData.data.set(new Uint8ClampedArray(minimapPixels.buffer));

    ctx.putImageData(imageData, -borderSize * 4, -borderSize * 4);

    return canvas.convertToBlob();
}
