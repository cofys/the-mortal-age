import type { SkillId } from "../../../rs/skill/skills";

/**
 * A skill's experience, level or boosted level arrived from the server (RuneLite's
 * StatChanged). Posted for every skill in a stats snapshot (as on login) and for each skill
 * in a stats update, whether or not its experience changed.
 */
export class StatChanged {
    constructor(
        private readonly skill: SkillId,
        private readonly xp: number,
        private readonly level: number,
        private readonly boostedLevel: number,
    ) {}

    getSkill(): SkillId {
        return this.skill;
    }

    getXp(): number {
        return this.xp;
    }

    /** The real (unboosted, non-virtual) level. */
    getLevel(): number {
        return this.level;
    }

    getBoostedLevel(): number {
        return this.boostedLevel;
    }
}
