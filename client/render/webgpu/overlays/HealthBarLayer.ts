import type { CacheIndex } from "../../../rs/cache/CacheIndex";
import type { CacheInfo } from "../../../rs/cache/CacheInfo";
import { ConfigType } from "../../../rs/cache/ConfigType";
import { IndexType } from "../../../rs/cache/IndexType";
import { HealthBarDefinition } from "../../../rs/config/healthbar/HealthBarDefinition";
import { ArchiveHealthBarDefinitionLoader } from "../../../rs/config/healthbar/HealthBarDefinitionLoader";
import { IndexedSprite } from "../../../rs/sprite/IndexedSprite";
import { SpriteLoader } from "../../../rs/sprite/SpriteLoader";
import type { OverlayHost } from "./OverlayHost";
import type { ScreenLayer, ScreenTexture } from "./ScreenLayer";
import { indexedSpriteToPixels } from "./textTextures";

/**
 * Port of client/ui/devoverlay/HealthBarOverlay.ts to the WebGPU screen layer. The fill
 * animation and definition handling are unchanged.
 */
export class HealthBarLayer {
    private readonly host: OverlayHost;
    private readonly screen: ScreenLayer;

    private spriteIndex?: CacheIndex;
    private defs?: Map<number, HealthBarDefinition>;
    private defaultDefId = 0;

    private spriteTextures = new Map<number, ScreenTexture>();
    private fallbackTexture?: ScreenTexture;

    private stackOffsets = new Map<number, number>();

    scale = 1.0;

    constructor(host: OverlayHost, screen: ScreenLayer) {
        this.host = host;
        this.screen = screen;
    }

    init(): void {
        this.initAssetsFromCache();
    }

    getDefinition(id?: number): HealthBarDefinition | undefined {
        return this.resolveDefinition(id);
    }

    draw(): void {
        const args = this.host.buildUpdateArgs();
        const entries = this.host.healthBarOutput;
        if (entries.length === 0) return;

        const helpers = args.helpers;
        const stacks = this.host.actor2dStacks;
        const gameCycle = this.host.clientCycle | 0;
        const visualScale =
            typeof this.scale === "number" && Number.isFinite(this.scale) && this.scale > 0
                ? this.scale
                : 1.0;

        for (const entry of entries) {
            const plane = entry.plane | 0;
            const height = helpers.getMinTileHeightInRadius(
                entry.worldX,
                entry.worldZ,
                plane,
                entry.footprintRadius ?? 0,
            );
            const headOffset = entry.heightOffsetTiles ?? 0.5;
            const screenPos = helpers.worldToScreen?.(
                entry.worldX,
                height - headOffset,
                entry.worldZ,
            );
            if (!screenPos || typeof screenPos[0] !== "number" || typeof screenPos[1] !== "number") {
                continue;
            }

            const definition = this.resolveDefinition(entry.defId);
            const back = this.textureFromSprite(definition?.backSpriteId);
            const front = this.textureFromSprite(definition?.frontSpriteId);
            const groupKey = typeof entry.groupKey === "number" ? entry.groupKey | 0 : undefined;
            let var18 = (groupKey !== undefined ? stacks.get(groupKey) : undefined) ?? -2;

            const barWidth = Math.max(1, (definition?.width ?? 30) | 0);
            const displayDuration = (definition?.int5 ?? 70) | 0;
            const fadeOutStartCycle = (definition?.int3 ?? -1) | 0;
            const secondarySaturation = (definition?.stepIncrement ?? 1) | 0;
            const elapsed = gameCycle - (entry.cycle | 0);
            if (elapsed < 0) continue;
            const remaining = displayDuration + (entry.cycleOffset | 0) - elapsed;
            if (remaining <= 0) continue;

            let pad = 0;
            let usable: number;
            if (back && front) {
                const padding = (definition?.widthPadding ?? 0) | 0;
                if (padding * 2 < front.width) {
                    pad = padding;
                }
                usable = front.width - pad * 2;
            } else {
                usable = barWidth;
            }

            let alpha256 = 255;
            const target = Math.trunc((usable * (entry.health2 | 0)) / barWidth);
            let fill: number;
            if ((entry.cycleOffset | 0) > elapsed) {
                const step =
                    secondarySaturation === 0
                        ? 0
                        : secondarySaturation * Math.trunc(elapsed / secondarySaturation);
                const start = Math.trunc((usable * (entry.health | 0)) / barWidth);
                fill = Math.trunc((step * (target - start)) / (entry.cycleOffset | 0)) + start;
            } else {
                fill = target;
                if (fadeOutStartCycle >= 0) {
                    alpha256 = Math.trunc((remaining << 8) / (displayDuration - fadeOutStartCycle));
                }
            }
            if ((entry.health2 | 0) > 0 && fill < 1) {
                fill = 1;
            }
            const alpha = alpha256 >= 0 && alpha256 < 255 ? alpha256 / 255 : 1;

            const centerX = Math.round(screenPos[0]);
            const centerY = Math.round(screenPos[1]);
            const drawQuad = (
                tex: ScreenTexture,
                x: number,
                y: number,
                w: number,
                h: number,
                uMax = 1,
                vMax = 1,
                r = 1,
                g = 1,
                b = 1,
            ): void => {
                this.screen.queueTexture(
                    tex,
                    centerX + x,
                    centerY + y,
                    w,
                    h,
                    0,
                    0,
                    uMax,
                    vMax,
                    r,
                    g,
                    b,
                    alpha,
                );
            };

            if (back && front) {
                if (fill === usable) {
                    fill += pad * 2;
                } else {
                    fill += pad;
                }

                const backW = back.width * visualScale;
                const backH = back.height * visualScale;
                const padS = pad * visualScale;
                const usableS = usable * visualScale;
                const fillS = fill * visualScale;

                var18 += backH;
                const y = -var18;
                const x = -(usableS * 0.5) - padS;

                drawQuad(back, x, y, backW, backH);

                if (fillS > 0) {
                    const clipH = Math.min(front.height, back.height) * visualScale;
                    drawQuad(
                        front,
                        x,
                        y,
                        fillS,
                        clipH,
                        fill / front.width,
                        clipH / (front.height * visualScale),
                    );
                }
                var18 += 2 * visualScale;
            } else {
                fill = Math.max(0, Math.min(usable, fill));
                const barH = 5 * visualScale;
                const usableS = usable * visualScale;
                const fillS = fill * visualScale;
                var18 += barH;
                const y = -var18;
                const x = -(usableS * 0.5);
                const fallback = this.ensureFallbackTexture();
                if (fillS > 0) {
                    drawQuad(fallback, x, y, fillS, barH, 1, 1, 0, 1, 0);
                }
                if (fillS < usableS) {
                    drawQuad(fallback, x + fillS, y, usableS - fillS, barH, 1, 1, 1, 0, 0);
                }
                var18 += 2 * visualScale;
            }

            if (groupKey !== undefined) {
                stacks.set(groupKey, var18 | 0);
            }
        }
    }

    dispose(): void {
        for (const sprite of this.spriteTextures.values()) this.screen.releaseTexture(sprite);
        this.spriteTextures.clear();
        if (this.fallbackTexture) this.screen.releaseTexture(this.fallbackTexture);
        this.fallbackTexture = undefined;
    }

    private initAssetsFromCache(): void {
        try {
            const cacheSystem = this.host.osrsClient.cacheSystem;
            if (!cacheSystem) return;
            const configIndex = cacheSystem.getIndex(IndexType.DAT2.configs);
            if (!configIndex.archiveExists(ConfigType.OSRS.healthBar)) return;
            const cacheInfo = this.host.osrsClient.loadedCache?.info as CacheInfo | undefined;
            if (!cacheInfo) return;
            const archive = configIndex.getArchive(ConfigType.OSRS.healthBar);
            const loader = new ArchiveHealthBarDefinitionLoader(cacheInfo, archive);
            const ids = Array.from(archive.fileIds) as number[];
            ids.sort((a, b) => a - b);
            const map = new Map<number, HealthBarDefinition>();
            for (const id of ids) {
                try {
                    const def = loader.load(id);
                    if (def) map.set(id, def);
                } catch {}
            }
            if (map.size > 0) {
                this.defs = map;
                this.defaultDefId = ids[0] ?? 0;
            }
        } catch {}

        try {
            this.spriteIndex = this.host.osrsClient.cacheSystem.getIndex(IndexType.DAT2.sprites);
        } catch {
            this.spriteIndex = undefined;
        }
    }

    private ensureFallbackTexture(): ScreenTexture {
        if (this.fallbackTexture) return this.fallbackTexture;
        const texture = this.screen.createPixelTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        this.fallbackTexture = texture;
        return texture;
    }

    private textureFromSprite(id: number | undefined): ScreenTexture | undefined {
        if (id == null || id < 0) return undefined;
        const cached = this.spriteTextures.get(id);
        if (cached) return cached;
        const spriteIndex = this.spriteIndex;
        if (!spriteIndex) return undefined;
        try {
            const indexed = SpriteLoader.loadIntoIndexedSprite(spriteIndex, id);
            if (!indexed) return undefined;
            const sprite = this.createTextureFromIndexedSprite(indexed);
            this.spriteTextures.set(id, sprite);
            return sprite;
        } catch {
            return undefined;
        }
    }

    private createTextureFromIndexedSprite(spr: IndexedSprite): ScreenTexture {
        const { pixels, width, height } = indexedSpriteToPixels(spr);
        return this.screen.createPixelTexture(pixels, width, height);
    }

    private resolveDefinition(id?: number): HealthBarDefinition | undefined {
        const defs = this.defs;
        if (!defs || defs.size === 0) return undefined;
        const targetId = typeof id === "number" && defs.has(id) ? id : this.defaultDefId;
        return defs.get(targetId);
    }
}
