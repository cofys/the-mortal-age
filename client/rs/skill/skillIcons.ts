import { SkillId } from "./skills";

/**
 * Cache sprite archives of the 25x25 skill icons the stats tab shows (RuneLite's
 * SpriteID.SKILL_*), indexed by SkillId. Sailing's icon came later, after the total.
 */
const SKILL_ICON_SPRITES: Record<SkillId, number> = {
    [SkillId.Attack]: 197,
    [SkillId.Strength]: 198,
    [SkillId.Defence]: 199,
    [SkillId.Ranged]: 200,
    [SkillId.Prayer]: 201,
    [SkillId.Magic]: 202,
    [SkillId.Hitpoints]: 203,
    [SkillId.Agility]: 204,
    [SkillId.Herblore]: 205,
    [SkillId.Thieving]: 206,
    [SkillId.Crafting]: 207,
    [SkillId.Fletching]: 208,
    [SkillId.Mining]: 209,
    [SkillId.Smithing]: 210,
    [SkillId.Fishing]: 211,
    [SkillId.Cooking]: 212,
    [SkillId.Firemaking]: 213,
    [SkillId.Woodcutting]: 214,
    [SkillId.Runecraft]: 215,
    [SkillId.Slayer]: 216,
    [SkillId.Farming]: 217,
    [SkillId.Hunter]: 220,
    [SkillId.Construction]: 221,
    [SkillId.Sailing]: 228,
};

/** The total level icon (RuneLite's SpriteID.SKILL_TOTAL). */
export const OVERALL_ICON_SPRITE = 222;

export function skillIconSprite(skill: SkillId): number {
    return SKILL_ICON_SPRITES[skill];
}
