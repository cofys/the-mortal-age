import { SkillId } from "../../../rs/skill/skills";

/** RuneLite's SkillColor: each skill's progress bar colour. */
const SKILL_COLOR: Record<SkillId, [number, number, number]> = {
    [SkillId.Attack]: [155, 32, 7],
    [SkillId.Defence]: [98, 119, 190],
    [SkillId.Strength]: [4, 149, 90],
    [SkillId.Hitpoints]: [131, 126, 126],
    [SkillId.Ranged]: [109, 144, 23],
    [SkillId.Prayer]: [159, 147, 35],
    [SkillId.Magic]: [50, 80, 193],
    [SkillId.Cooking]: [112, 35, 134],
    [SkillId.Woodcutting]: [52, 140, 37],
    [SkillId.Fletching]: [3, 141, 125],
    [SkillId.Fishing]: [106, 132, 164],
    [SkillId.Firemaking]: [189, 120, 25],
    [SkillId.Crafting]: [151, 110, 77],
    [SkillId.Smithing]: [108, 107, 82],
    [SkillId.Mining]: [93, 143, 167],
    [SkillId.Herblore]: [7, 133, 9],
    [SkillId.Agility]: [58, 60, 137],
    [SkillId.Thieving]: [108, 52, 87],
    [SkillId.Slayer]: [100, 100, 100],
    [SkillId.Farming]: [101, 152, 63],
    [SkillId.Runecraft]: [170, 141, 26],
    [SkillId.Hunter]: [92, 89, 65],
    [SkillId.Construction]: [130, 116, 95],
    [SkillId.Sailing]: [11, 165, 157],
};

/** The colour as renderer RGBA (0-1). */
export function skillColor(skill: SkillId): [number, number, number, number] {
    const [r, g, b] = SKILL_COLOR[skill];
    return [r / 255, g / 255, b / 255, 1];
}

export function skillColorCss(skill: SkillId): string {
    const [r, g, b] = SKILL_COLOR[skill];
    return `rgb(${r}, ${g}, ${b})`;
}
