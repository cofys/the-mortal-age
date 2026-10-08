import { BitmapFont } from "../../../rs/font/BitmapFont";
import { FONT_BOLD_12 } from "../../../ui/fonts";
import type { OverlayHost } from "./OverlayHost";
import type { ScreenLayer, ScreenTexture } from "./ScreenLayer";

type GlyphMeta = {
    ch: number;
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    w: number;
    h: number;
    lb: number;
    tb: number;
    adv: number;
};

/**
 * Port of client/ui/devoverlay/TileTextOverlay.ts. Only the coords-only hover label is ever
 * produced by the WebGL renderer feeding the overlay today (the tile-flags mode has no
 * producer); the atlas and clamp-to-viewport layout are ported in full.
 */
export class TileTextLayer {
    private readonly host: OverlayHost;
    private readonly screen: ScreenLayer;

    private texture?: ScreenTexture;
    private glyphs = new Map<number, GlyphMeta>();
    private ascent = 12;

    fontId: number = FONT_BOLD_12;
    scale = 1.0;
    color = 0xffffff;

    constructor(host: OverlayHost, screen: ScreenLayer) {
        this.host = host;
        this.screen = screen;
    }

    init(): void {
        this.buildAtlas(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,:'-_.()[]/+",
        );
    }

    draw(): void {
        if (!this.texture) return;
        const args = this.host.buildUpdateArgs();
        const state = args.state;
        if (!state.hoverEnabled || !state.hoverTile) return;

        const x = state.hoverTile.x | 0;
        const y = state.hoverTile.y | 0;
        const basePlane = state.playerLevel | 0;
        const text = `tile (${x}, ${y})`;
        if (text.length === 0) return;

        const helpers = args.helpers;
        const effPlane = helpers.getEffectivePlaneForTile(x, y, basePlane) | 0;
        const h = helpers.sampleHeightAtExactPlane(x + 0.5, y + 0.5, effPlane);
        const centerX = x + 0.5;
        const centerY = h - 0.6;
        const centerZ = y + 0.5;

        const col = this.color >>> 0;
        const tr = ((col >> 16) & 0xff) / 255.0;
        const tg = ((col >> 8) & 0xff) / 255.0;
        const tb = (col & 0xff) / 255.0;

        const scale = this.scale || 1.0;
        let advTotal = 0;
        for (let i = 0; i < text.length; i++) {
            const g = this.glyphs.get(text.charCodeAt(i));
            advTotal += (g?.adv ?? g?.w ?? 0) + (i > 0 ? 0.75 : 0);
        }
        const textWidth = advTotal * scale;
        const textHeight = this.ascent * scale;
        let penX = -(textWidth / 2);
        let penY = -(textHeight / 2);

        const anchorScreen = helpers.worldToScreen?.(centerX, centerY, centerZ);
        if (!anchorScreen) return;
        const pad = 2;
        const anchorX = anchorScreen[0] | 0;
        const anchorY = anchorScreen[1] | 0;

        const left = anchorX + penX;
        const right = left + textWidth;
        if (left < pad) {
            penX += pad - left;
        } else if (right > this.host.canvas.width - pad) {
            penX -= right - (this.host.canvas.width - pad);
        }

        const top = anchorY + penY;
        const bottom = top + textHeight;
        if (top < pad) {
            penY += pad - top;
        } else if (bottom > this.host.canvas.height - pad) {
            penY -= bottom - (this.host.canvas.height - pad);
        }

        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            const g = this.glyphs.get(ch);
            if (!g) continue;
            const gw = (g.w * scale) | 0;
            const gh = (g.h * scale) | 0;
            const gx = anchorX + ((penX + g.lb * scale) | 0);
            const gy = anchorY + ((penY + g.tb * scale) | 0);
            this.screen.queueTexture(
                this.texture,
                gx,
                gy,
                gw,
                gh,
                g.u0,
                g.v0,
                g.u1,
                g.v1,
                tr,
                tg,
                tb,
                1,
            );
            penX += (g.adv ?? g.w) * scale + 0.75 * scale;
        }
    }

    dispose(): void {
        if (this.texture) this.screen.releaseTexture(this.texture);
        this.texture = undefined;
        this.glyphs.clear();
    }

    private buildAtlas(charset: string): void {
        try {
            const cache = this.host.osrsClient.cacheSystem;
            if (!cache) return;
            const bmp = BitmapFont.tryLoad(cache, this.fontId);
            if (!bmp) return;
            this.ascent = bmp.ascent | 0;
            const chars = Array.from(new Set(charset.split(""))).map((c) => c.charCodeAt(0));
            let W = 2;
            let H = 1;
            const metas: GlyphMeta[] = [];
            for (const ch of chars) {
                const w = (bmp.widths[ch] | 0) || 1;
                const h = (bmp.heights[ch] | 0) || 1;
                const lb = bmp.leftBearings[ch] | 0;
                const tb = bmp.topBearings[ch] | 0;
                const adv = (bmp.advances[ch] | 0) || w;
                metas.push({ ch, u0: 0, v0: 0, u1: 0, v1: 0, w, h, lb, tb, adv });
                W += w + 1;
                H = Math.max(H, h);
            }
            W |= 0;
            H = Math.max(1, H | 0);
            const out = new Uint8Array(W * H * 4);
            let penX = 1;
            for (const m of metas) {
                const gp = bmp.glyphPixels[m.ch];
                const w = m.w | 0;
                const h = m.h | 0;
                if (gp) {
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const idx = gp[y * w + x] & 0xff;
                            if (idx === 0) continue;
                            const di = (penX + x + y * W) * 4;
                            out[di] = 255;
                            out[di + 1] = 255;
                            out[di + 2] = 255;
                            out[di + 3] = 255;
                        }
                    }
                }
                m.u0 = penX / W;
                m.v0 = 0;
                m.u1 = (penX + w) / W;
                m.v1 = h / H;
                this.glyphs.set(m.ch, m);
                penX += w + 1;
            }
            this.texture = this.screen.createPixelTexture(out, W, H);
        } catch {}
    }
}
