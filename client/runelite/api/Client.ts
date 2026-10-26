import type { SkillId } from "../../rs/skill/skills";
import type { GameState } from "./GameState";

/** The local player, as far as ported plugins read it (RuneLite's `Player`). */
export interface Player {
    getName(): string;
    getCombatLevel(): number;
}

/**
 * RuneLite's `net.runelite.api.Client`, cut down to the methods ported plugins call. Methods we
 * don't implement are absent, so a port that needs one fails to compile
 * (docs/RuneLite_API_shape_implementation.md, §4.4).
 */
export interface Client {
    getGameState(): GameState;
    getLocalPlayer(): Player | null;
    getVarpValue(varpId: number): number;
    getRealSkillLevel(skill: SkillId): number;
    /** Runs a cache client script; its return values are left on the int stack. */
    runScript(scriptId: number, ...args: number[]): void;
    getIntStack(): ArrayLike<number>;
}
