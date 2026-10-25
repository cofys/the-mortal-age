import {
    MAX_REAL_LEVEL,
    MAX_VIRTUAL_LEVEL,
    MAX_XP,
    SKILL_NAME,
    type SkillId,
    getLevelForXp,
    getXpForLevel,
} from "../../../rs/skill/skills";

/** One globe: RuneLite's XpGlobe. `time` is when it last changed or was hovered (ms). */
export type XpGlobe = { skill: SkillId; currentXp: number; currentLevel: number; time: number };

/** RuneLite's MAXIMUM_SHOWN_GLOBES. */
export const MAXIMUM_SHOWN_GLOBES = 5;

/**
 * The globes to show (RuneLite's XpGlobesPlugin state): the first stat value for a skill only
 * fills the cache (the login sync shows nothing); after that, more experience shows its globe.
 */
export class XpGlobes {
    private cache = new Map<SkillId, XpGlobe>();
    /** Shown globes, ordered by skill. */
    globes: XpGlobe[] = [];

    onStatChanged(
        skill: SkillId,
        currentXp: number,
        level: number,
        now: number,
        options: { hideMaxed: boolean; showVirtualLevel: boolean },
    ): void {
        const cached = this.cache.get(skill);
        // Boosts and drains post StatChanged too: only more experience counts.
        if (cached && cached.currentXp >= currentXp) return;
        let currentLevel = level;
        if (currentLevel >= MAX_REAL_LEVEL) {
            if (options.hideMaxed) return;
            if (options.showVirtualLevel) currentLevel = getLevelForXp(currentXp);
        }
        if (!cached) {
            this.cache.set(skill, { skill, currentXp, currentLevel, time: now });
            return;
        }
        cached.currentXp = currentXp;
        cached.currentLevel = currentLevel;
        cached.time = now;
        this.add(cached);
    }

    private add(globe: XpGlobe): void {
        if (this.globes.includes(globe)) return;
        const at = this.globes.findIndex((g) => g.skill > globe.skill);
        this.globes.splice(at < 0 ? this.globes.length : at, 0, globe);
        if (this.globes.length > MAXIMUM_SHOWN_GLOBES) {
            const oldest = this.globes.reduce((a, b) => (b.time < a.time ? b : a));
            this.globes.splice(this.globes.indexOf(oldest), 1);
        }
    }

    /** RuneLite's removeExpiredXpGlobes, run every second. */
    expire(now: number, durationSeconds: number): void {
        const expireTime = now - durationSeconds * 1000;
        this.globes = this.globes.filter((g) => !(g.time < expireTime));
    }

    reset(): void {
        this.globes = [];
        this.cache = new Map();
    }
}

/** RuneLite's getSkillProgress: percent from the goal start to the goal. */
export function skillProgress(startXp: number, currentXp: number, goalXp: number): number {
    return ((currentXp - startXp) / (goalXp - startXp)) * 100;
}

/** The goal range without the XP Tracker: this level to the next (200M past the last). */
export function levelGoals(currentXp: number): { start: number; end: number } {
    const level = getLevelForXp(currentXp);
    return {
        start: getXpForLevel(level),
        end: level + 1 <= MAX_VIRTUAL_LEVEL ? getXpForLevel(level + 1) : MAX_XP,
    };
}

/** The XP Tracker numbers the tooltip uses (RuneLite's XpTrackerService). */
export type XpTrackerNumbers = { actionsLeft: number; xpHr: number; timeTilGoal: string };

export type TooltipLine = { left: string; right: string; leftColor: number };

/** java.awt.Color.ORANGE and WHITE. */
export const ORANGE = 0xffc800;
const WHITE = 0xffffff;

/** RuneLite's DecimalFormat("###,###,###"). */
export function formatXp(value: number): string {
    return Math.round(value).toLocaleString("en-US");
}

/** The tooltip panel's lines (RuneLite's drawTooltip); the tracker lines need XP Tracker. */
export function tooltipLines(
    globe: XpGlobe,
    goalXp: number,
    tracker: XpTrackerNumbers | undefined,
    options: { showActionsLeft: boolean; showXpLeft: boolean; showXpHour: boolean; showTimeTilGoal: boolean },
): TooltipLine[] {
    const lines: TooltipLine[] = [
        { left: SKILL_NAME[globe.skill], right: String(globe.currentLevel), leftColor: WHITE },
        { left: "Current XP:", right: formatXp(globe.currentXp), leftColor: ORANGE },
    ];
    if (goalXp > globe.currentXp) {
        if (options.showActionsLeft && tracker && tracker.actionsLeft !== 2147483647) {
            lines.push({ left: "Actions left:", right: formatXp(tracker.actionsLeft), leftColor: ORANGE });
        }
        if (options.showXpLeft) {
            lines.push({ left: "XP left:", right: formatXp(goalXp - globe.currentXp), leftColor: ORANGE });
        }
        if (options.showXpHour && tracker && tracker.xpHr !== 0) {
            lines.push({ left: "XP per hour:", right: formatXp(tracker.xpHr), leftColor: ORANGE });
        }
        if (options.showTimeTilGoal && tracker) {
            lines.push({ left: "Time left:", right: tracker.timeTilGoal, leftColor: ORANGE });
        }
    }
    return lines;
}

/**
 * Points along a circle arc, as Java's Arc2D draws it: angles in degrees anticlockwise from
 * 3 o'clock, a negative extent going clockwise; screen y grows downwards.
 */
export function arcPoints(cx: number, cy: number, r: number, startDeg: number, extentDeg: number): [number, number][] {
    const steps = Math.max(2, Math.ceil(Math.abs(extentDeg) / 6));
    const points: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
        const a = ((startDeg + (extentDeg * i) / steps) * Math.PI) / 180;
        points.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
    }
    return points;
}
