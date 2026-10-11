/**
 * Server-driven OSRS hint arrow state.
 *
 * The server sends an NPC hint (type 1, the Kalphite Queen head icon), a player hint
 * (type 3, an overhead arrow riding the actor, e.g. a Castle Wars flag carrier) or a
 * tile hint (type 2). Tile hints are drawn by [TutorialHintOverlay]; actor hints join
 * the player's overhead head icons so they follow the rendered head smoothly.
 */
export interface HintArrowState {
    /** 0 = none, 1 = npc, 2 = tile, 3 = player. */
    type: number;
    npcId: number;
    /** Server id of the hinted player for type 3 hints. */
    playerId: number;
    x: number;
    y: number;
    /** OSRS's height byte for type 2 hints: the arrow sits height * 2 world units (128 a tile) up. */
    height: number;
    /** OSRS's position type for type 2 hints: 2 centre, 3 west, 4 east, 5 south, 6 north edge. */
    position: number;
    /** Floor the tile hint sits on; hints on another plane are not drawn. */
    plane: number;
}

export const hintArrow: HintArrowState = { type: 0, npcId: 0, playerId: 0, x: 0, y: 0, height: 0, position: 2, plane: 0 };

export function setHintArrowNpc(npcId: number): void {
    hintArrow.type = 1;
    hintArrow.npcId = npcId | 0;
}

/** A tile hint: OSRS's height byte, and OSRS's position type (bits 2-4) with the plane (bits 0-1). */
export function setHintArrowTile(x: number, y: number, height: number, packed: number): void {
    hintArrow.type = 2;
    hintArrow.x = x | 0;
    hintArrow.y = y | 0;
    hintArrow.height = (height | 0) & 0xff;
    const position = ((packed | 0) >> 2) & 0x07;
    hintArrow.position = position >= 2 && position <= 6 ? position : 2;
    hintArrow.plane = (packed | 0) & 0x03;
}

/**
 * Where on its tile a tile hint points, in 1/128 tile units, as the OSRS client places it:
 * the centre, or the middle of the west, east, south or north edge.
 */
export function hintArrowTileOffset(position: number): [number, number] {
    switch (position) {
        case 3: return [0, 64];
        case 4: return [128, 64];
        case 5: return [64, 0];
        case 6: return [64, 128];
        default: return [64, 64];
    }
}

/** An overhead arrow over a specific player, for as long as the server keeps sending it. */
export function setHintArrowPlayer(playerId: number): void {
    hintArrow.type = 3;
    hintArrow.playerId = playerId | 0;
}

export function clearHintArrow(): void {
    hintArrow.type = 0;
}

/** Native blink: visible while `gameCycle % 20 < 10`, with gameCycle ticking every 20ms. */
export function isHintArrowBlinkOn(): boolean {
    return Math.floor(performance.now() / 20) % 20 < 10;
}
