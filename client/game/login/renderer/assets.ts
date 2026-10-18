import { CacheIndex } from "../../../rs/cache/CacheIndex";
import { CacheSystem } from "../../../rs/cache/CacheSystem";
import { IndexType } from "../../../rs/cache/IndexType";
import { BitmapFont } from "../../../rs/font/BitmapFont";
import { IndexedSprite } from "../../../rs/sprite/IndexedSprite";
import { SpriteLoader } from "../../../rs/sprite/SpriteLoader";
import { LoginScreenAnimation } from "../LoginScreenAnimation";
import type { LoginRendererHost } from "./host";

const PUBLIC_PATH = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

function loadSprite(spriteIndex: CacheIndex, name: string) {

        try {
            const archiveId = spriteIndex.getArchiveId(name);
            if (archiveId === -1) return undefined;
            return SpriteLoader.loadIntoIndexedSprite(spriteIndex, archiveId);
        } catch {
            return undefined;
        }
    
}

function loadSprites(spriteIndex: CacheIndex, name: string) {

        try {
            const archiveId = spriteIndex.getArchiveId(name);
            if (archiveId !== -1) return SpriteLoader.loadIntoIndexedSprites(spriteIndex, archiveId);
            // Newer caches split some groups into one archive per frame: "name,0", "name,1", ...
            const frames: IndexedSprite[] = [];
            for (let frameId = spriteIndex.getArchiveId(`${name},0`); frameId !== -1; ) {
                const frame = SpriteLoader.loadIntoIndexedSprite(spriteIndex, frameId);
                if (!frame) return undefined;
                frames.push(frame);
                frameId = spriteIndex.getArchiveId(`${name},${frames.length}`);
            }
            return frames.length > 0 ? frames : undefined;
        } catch {
            return undefined;
        }
    
}

export function loadLogoImage(host: LoginRendererHost): Promise<boolean> {

        if (host.logoImage && host.logoImageLoaded) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            host.logoImage = new Image();
            host.logoImage.onload = () => {
                host.logoImageLoaded = true;
                console.log("[LoginRenderer] Logo image loaded from PNG");
                resolve(true);
            };
            host.logoImage.onerror = () => {
                console.warn("[LoginRenderer] Failed to load logo image from PNG");
                host.logoImage = undefined;
                host.logoImageLoaded = false;
                resolve(false);
            };
            host.logoImage.src = `${PUBLIC_PATH}/images/logo.png`;
        });
    
}

export async function loadTitleBackground(host: LoginRendererHost): Promise<boolean> {

        try {
            const response = await fetch(`${PUBLIC_PATH}/images/loading-bg.jpg`);
            if (response.ok) {
                const blob = await response.blob();
                const imageBitmap = await createImageBitmap(blob);
                host.titleBackgroundImage = imageBitmap;
                console.log("[LoginRenderer] Title background loaded");
                return true;
            }
        } catch (e) {
            console.warn("[LoginRenderer] Title background load failed:", e);
        }
        return false;
    
}

export function loadTitleSprites(host: LoginRendererHost, cache: CacheSystem) {

        try {
            // Note: Logo PNG image is loaded separately via loadLogoImage()
            // This avoids async race conditions during phased loading

            const spriteIndex = cache.getIndex(IndexType.DAT2.sprites);

            host.logoSprite = loadSprite(spriteIndex, "logo");
            host.titleboxSprite = loadSprite(spriteIndex, "titlebox");
            host.titlebuttonSprite = loadSprite(spriteIndex, "titlebutton");
            host.titlebuttonLargeSprite = loadSprite(spriteIndex, "titlebutton_large");
            host.playNowTextSprite = loadSprite(spriteIndex, "play_now_text");
            host.runesSprites = loadSprites(spriteIndex, "runes");
            host.titleMuteSprites = loadSprites(spriteIndex, "title_mute");

            const radioSprites = loadSprites(spriteIndex, "options_radio_buttons");
            if (radioSprites) {
                host.optionsRadioSprite0 = radioSprites[0];
                host.optionsRadioSprite2 = radioSprites[2];
                host.optionsRadioSprite4 = radioSprites[4];
                host.optionsRadioSprite6 = radioSprites[6];
            }

            host.worldSelectLeftSprite = loadSprite(spriteIndex, "leftarrow");
            host.worldSelectRightSprite = loadSprite(spriteIndex, "rightarrow");
            host.worldSelectButtonSprite = loadSprite(spriteIndex, "sl_button");
            host.worldSelectBackSprites = loadSprites(spriteIndex, "sl_back");
            host.worldSelectFlagSprites = loadSprites(spriteIndex, "sl_flags");
            host.worldSelectStarSprites = loadSprites(spriteIndex, "sl_stars");
            host.worldSelectArrowSprites = loadSprites(spriteIndex, "sl_arrows");

            if (host.runesSprites) {
                host.loginScreenRunesAnimation = new LoginScreenAnimation(host.runesSprites);
            }

            return true;
        } catch (e) {
            console.warn("[LoginRenderer] Failed to load title sprites:", e);
            return false;
        }
    
}

export function loadFonts(host: LoginRendererHost, cache: CacheSystem) {

        try {
            host.fontBold12 = BitmapFont.tryLoad(cache, 496);
            host.fontPlain11 = BitmapFont.tryLoad(cache, 494);
            host.fontPlain12 = BitmapFont.tryLoad(cache, 495);
            return !!(host.fontBold12 && host.fontPlain11 && host.fontPlain12);
        } catch (e) {
            console.warn("[LoginRenderer] Failed to load fonts:", e);
            return false;
        }
    
}
