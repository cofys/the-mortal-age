/** The pure parts of RuneLite's Opponent Information: health estimates, labels and opponent tracking. */

export const HITPOINTS_DISPLAY_STYLES = {
    Hitpoints: "hitpoints",
    Percentage: "percentage",
    Both: "both",
} as const;
export type HitpointsDisplayStyle =
    (typeof HITPOINTS_DISPLAY_STYLES)[keyof typeof HITPOINTS_DISPLAY_STYLES];

/** How long the last opponent stays shown after the player stops interacting with it. */
export const OPPONENT_WAIT_MS = 5_000;

export type ActorRef = { type: "npc" | "player"; serverId: number };

export const sameActor = (a: ActorRef | undefined, b: ActorRef | undefined): boolean =>
    a?.type === b?.type && a?.serverId === b?.serverId;

/**
 * The health a health bar ratio stands for, given the actor's maximum.
 *
 * The reverse of the server's `ratio = 1 + (scale - 1) * health / max` (0 only at 0 health):
 * the average of the lowest and highest health giving this ratio. Exact when max <= scale.
 */
export function estimateHealth(ratio: number, scale: number, maxHealth: number): number {
    if (ratio <= 0) return 0;
    let minHealth = 1;
    let highest: number;
    if (scale > 1) {
        // A ratio of 1 can be any health from 1, as 0 health always sends 0.
        if (ratio > 1) minHealth = Math.trunc((maxHealth * (ratio - 1) + scale - 2) / (scale - 1));
        highest = Math.min(Math.trunc((maxHealth * ratio - 1) / (scale - 1)), maxHealth);
    } else {
        // A scale of 1 only tells alive from dead.
        highest = maxHealth;
    }
    return Math.trunc((minHealth + highest + 1) / 2);
}

/** "37.5%", as RuneLite's `0.0` format. */
export function percentText(current: number, maximum: number): string {
    return `${((100 * current) / maximum).toFixed(1)}%`;
}

export type HealthBarLabel = { value: number; maximum: number; text: string };

/**
 * The opponent panel's bar: hitpoints ("312/500") when the maximum is known and wanted, both
 * ("312/500 (62.4%)"), else the bar's percentage.
 */
export function healthBarLabel(
    ratio: number,
    scale: number,
    maxHealth: number | undefined,
    style: HitpointsDisplayStyle,
): HealthBarLabel {
    if (style !== "percentage" && maxHealth !== undefined && maxHealth > 0) {
        const value = estimateHealth(ratio, scale, maxHealth);
        const full = `${value}/${maxHealth}`;
        return {
            value,
            maximum: maxHealth,
            text: style === "both" ? `${full} (${percentText(value, maxHealth)})` : full,
        };
    }
    const value = (ratio / scale) * 100;
    return { value, maximum: 100, text: percentText(value, 100) };
}

/**
 * The boss health bar's text (hpbar_hud) in the chosen style; undefined leaves the game's own.
 * The game writes "current / maximum" itself, so hitpoints keeps it.
 */
export function bossBarText(
    gameText: string,
    current: number,
    maximum: number,
    style: HitpointsDisplayStyle,
): string | undefined {
    if (maximum <= 0) return undefined;
    if (style === "percentage") return percentText(current, maximum);
    if (style === "both") return `${gameText} (${percentText(current, maximum)})`;
    return undefined;
}

/**
 * The player's last opponent: whoever they last interacted with, kept for five seconds after
 * they stop (RuneLite's InteractingChanged and GameTick rules).
 */
export class OpponentTracker {
    private current: ActorRef | undefined;
    private opponent: ActorRef | undefined;
    private stoppedAt: number | undefined;

    /** Feeds what the player is interacting with now; returns the opponent. */
    update(target: ActorRef | undefined, now: number): ActorRef | undefined {
        if (!sameActor(target, this.current)) {
            this.current = target;
            if (target) this.opponent = target;
            else this.stoppedAt = now;
        }
        if (
            this.opponent &&
            !this.current &&
            this.stoppedAt !== undefined &&
            now - this.stoppedAt > OPPONENT_WAIT_MS
        ) {
            this.opponent = undefined;
        }
        return this.opponent;
    }

    get lastOpponent(): ActorRef | undefined {
        return this.opponent;
    }

    reset(): void {
        this.current = undefined;
        this.opponent = undefined;
        this.stoppedAt = undefined;
    }
}
