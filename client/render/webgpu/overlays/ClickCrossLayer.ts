import { IndexType } from "../../../rs/cache/IndexType";
import { IndexedSprite } from "../../../rs/sprite/IndexedSprite";
import { SpriteLoader } from "../../../rs/sprite/SpriteLoader";
import type { OverlayHost } from "./OverlayHost";
import type { ScreenLayer, ScreenTexture } from "./ScreenLayer";
import { indexedSpriteToPixels } from "./textTextures";

type CrossAnim = {
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    basePlane: number;
    startTime: number;
    frameOffset: number;
};

/**
 * Port of client/ui/devoverlay/ClickCrossOverlay.ts: the 4-frame click sprite (sprite id 299),
 * yellow frames 0..3 and red frames 4..7, anchored to the clicked tile but aligned to the
 * original click screen point.
 */
export class ClickCrossLayer {
    private readonly host: OverlayHost;
    private readonly screen: ScreenLayer;

    private frames?: Array<{ texture: ScreenTexture; w: number; h: number }>;
    private queue: CrossAnim[] = [];
    private lastTimeMs = 0;

    frameDurationMs = 100;
    scale = 1.0;
    spriteId = 299;
    private yellowOffset = 0;
    private redOffset = 4;

    constructor(host: OverlayHost, screen: ScreenLayer) {
        this.host = host;
        this.screen = screen;
    }

    init(): void {
        this.initFramesFromCache();
    }

    setTime(timeMs: number): void {
        this.lastTimeMs = timeMs;
    }

    update(timeMs: number): void {
        this.lastTimeMs = timeMs;
        const animLen = this.frameDurationMs * 4;
        let writeIdx = 0;
        for (let i = 0; i < this.queue.length; i++) {
            if (timeMs - this.queue[i].startTime < animLen) {
                this.queue[writeIdx++] = this.queue[i];
            }
        }
        this.queue.length = writeIdx;
    }

    spawn(
        tileX: number,
        tileY: number,
        screenX: number,
        screenY: number,
        basePlane: number,
        atTime?: number,
        variant: "yellow" | "red" = "yellow",
    ): void {
        this.queue.push({
            x: tileX | 0,
            y: tileY | 0,
            screenX: screenX | 0,
            screenY: screenY | 0,
            basePlane: basePlane | 0,
            startTime: (atTime ?? this.lastTimeMs) | 0,
            frameOffset: variant === "red" ? this.redOffset : this.yellowOffset,
        });
    }

    draw(): void {
        if (!this.frames || this.frames.length === 0 || this.queue.length === 0) return;
        const args = this.host.buildUpdateArgs();
        const helpers = args.helpers;
        const now = this.lastTimeMs | 0;
        const fdur = Math.max(1, this.frameDurationMs | 0);

        for (const anim of this.queue) {
            const elapsed = Math.max(0, now - (anim.startTime | 0));
            const baseIndex = Math.floor(elapsed / fdur) | 0;
            if (baseIndex < 0 || baseIndex > 3) continue;
            const index = (anim.frameOffset | 0) + baseIndex;
            const frame = this.frames[index];
            if (!frame) continue;

            const effPlane =
                helpers.getHeightSamplePlaneForTile?.(
                    anim.x | 0,
                    anim.y | 0,
                    anim.basePlane | 0,
                ) ?? (anim.basePlane | 0);
            const h = helpers.getTileHeightAtPlane(anim.x + 0.5, anim.y + 0.5, effPlane);
            const scale = this.scale || 1.0;
            const w = (frame.w * scale) | 0;
            const hq = (frame.h * scale) | 0;

            // WebGL's click-cross shader projects u_centerWorld and adds the pixel-space
            // vertex offsets; with offX = clickScreenX - projectedX that cancels to the click
            // screen point, so the cross is pinned there. ScreenLayer draws absolute pixels,
            // so queue at that same point. worldToScreen is still consulted for the
            // behind-camera case the shader culls (w <= 0 maps to undefined here).
            const scr = helpers.worldToScreen?.(anim.x + 0.5, h - 0.05, anim.y + 0.5);
            if (!scr || typeof scr[0] !== "number" || typeof scr[1] !== "number") continue;

            this.screen.queueTexture(
                frame.texture,
                ((anim.screenX | 0) - (w >> 1)) | 0,
                ((anim.screenY | 0) - (hq >> 1)) | 0,
                w,
                hq,
            );
        }
    }

    dispose(): void {
        if (this.frames) {
            for (const frame of this.frames) this.screen.releaseTexture(frame.texture);
        }
        this.frames = undefined;
        this.queue.length = 0;
    }

    private initFramesFromCache(): void {
        try {
            const cacheSystem = this.host.osrsClient.cacheSystem;
            if (!cacheSystem) return;
            const spriteIndex = cacheSystem.getIndex(IndexType.DAT2.sprites);
            const sid = this.spriteId | 0;
            const sprites = SpriteLoader.loadIntoIndexedSprites(spriteIndex, sid);
            if (!sprites || sprites.length === 0) return;
            const frames: Array<{ texture: ScreenTexture; w: number; h: number }> = [];
            for (let i = 0; i < sprites.length; i++) {
                const sp = sprites[i] as IndexedSprite;
                const { pixels, width, height } = indexedSpriteToPixels(sp);
                frames.push({
                    texture: this.screen.createPixelTexture(pixels, width, height),
                    w: sp.subWidth | 0,
                    h: sp.subHeight | 0,
                });
            }
            this.frames = frames;
        } catch {}
    }
}
