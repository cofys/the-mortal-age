import { addSpriteOverride, removeSpriteOverride } from "../../../../widgets/gl/spriteOverrides";

/**
 * RuneLite's TabSprites: the tab images, under sprite ids the cache doesn't use. The PNGs are
 * RuneLite's (runelite-client/src/main/resources/.../banktags/tabs, BSD-2-Clause: see
 * public/runelite/banktags/LICENSE).
 */
export const TabSprites = {
    TAB_BACKGROUND: -201,
    TAB_BACKGROUND_ACTIVE: -202,
    UP_ARROW: -203,
    DOWN_ARROW: -204,
    NEW_TAB: -205,
} as const;

const FILES: Record<number, string> = {
    [TabSprites.TAB_BACKGROUND]: "tag-tab.png",
    [TabSprites.TAB_BACKGROUND_ACTIVE]: "tag-tab-active.png",
    [TabSprites.UP_ARROW]: "up-arrow.png",
    [TabSprites.DOWN_ARROW]: "down-arrow.png",
    [TabSprites.NEW_TAB]: "new-tab.png",
};

function url(file: string): string {
    const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
    return `${base}/runelite/banktags/${file}`;
}

/** SpriteManager.addSpriteOverrides(TabSprites.values()). */
export function addTabSprites(): void {
    for (const [id, file] of Object.entries(FILES)) addSpriteOverride(Number(id), url(file));
}

export function removeTabSprites(): void {
    for (const id of Object.keys(FILES)) removeSpriteOverride(Number(id));
}
