import * as AnimationID from "@runelite/api/gameval/AnimationID";
import * as NpcID from "@runelite/api/gameval/NpcID";

/** RuneLite's ParamID.NPC_DEATH_HIDER_EXCLUDE. */
export const NPC_DEATH_HIDER_EXCLUDE = 1799;

/** NPCs that reach 0 hitpoints without dying, or whose next form is attackable (NpcUtil.isDying). */
const NEVER_DEAD: ReadonlySet<number> = new Set([
    NpcID.SLAYER_GARGOYLE_1,
    NpcID.SLAYER_CAVE_GARGOYLE,
    NpcID.SUPERIOR_GARGOYLE,
    NpcID.GARGBOSS_DAWN_PHASE3,
    NpcID.GARGBOSS_DUSK_PHASE4,
    NpcID.SLAYER_MUTATED_ZYGOMITE_ADOLESCENT,
    NpcID.SLAYER_MUTATED_ZYGOMITE_ADULT,
    NpcID.FOSSIL_ZYGOMITE,
    NpcID.SLAYER_ROCKSLUG,
    NpcID.SLAYER_ROCKSLUG_BABY,
    NpcID.SUPERIOR_ROCKSLUG,
    NpcID.SLAYER_LIZARD_LARGE1_GREEN,
    NpcID.SLAYER_LIZARD_LARGE2_SANDY,
    NpcID.SLAYER_LIZARD_LARGE3_SANDY,
    NpcID.SLAYER_LIZARD_MASSIVE,
    NpcID.SLAYER_LIZARD_SMALL1_GREEN,
    NpcID.SLAYER_LIZARD_SMALL2_SANDY,
    NpcID.GB_GROWTHLING,
    NpcID.COLOSSEUM_MODIFIER_BEES,
    NpcID.KALPHITE_QUEEN,
    NpcID.VETION,
    NpcID.VETION_SINGLE,
    NpcID.SHAPESHIFTERGLOB,
    NpcID.NZONE_SHAPESHIFTERGLOB_NORMAL,
    NpcID.NZONE_SHAPESHIFTERGLOB_HARD,
    NpcID.SHAPESHIFTERSPIDER,
    NpcID.NZONE_SHAPESHIFTERSPIDER_NORMAL,
    NpcID.NZONE_SHAPESHIFTERSPIDER_HARD,
    NpcID.SHAPESHIFTERBEAR,
    NpcID.NZONE_SHAPESHIFTERBEAR_NORMAL,
    NpcID.NZONE_SHAPESHIFTERBEAR_HARD,
    NpcID.ZQ_MAINZOMBIE1,
    NpcID.ZQ_MAINZOMBIE2,
    NpcID.NZONE_ZQ_MAINZOMBIE1_NORMAL,
    NpcID.NZONE_ZQ_MAINZOMBIE2_NORMAL,
    NpcID.NZONE_ZQ_MAINZOMBIE1_HARD,
    NpcID.NZONE_ZQ_MAINZOMBIE2_HARD,
    NpcID.KOLHUMAN,
    NpcID.KOLOGRE,
    NpcID.KOLSPIDER,
    NpcID.KOLETHEREAL,
    NpcID.LOTR_TRAN_RAZORLOR_MUTANT,
    NpcID.AKD_XAMPHUR_COMBAT,
    NpcID.AKD_XAMPHUR_COMBAT_NOHANDS,
    NpcID.VIKING_ENEMY1,
    NpcID.VIKING_ENEMY2,
    NpcID.VIKING_ENEMY3,
    NpcID.FD_DAMIS_NORMAL,
    NpcID.NZONE_FD_DAMIS_NORMAL_NORMAL,
    NpcID.NZONE_FD_DAMIS_NORMAL_HARD,
    NpcID.CHOMPYBIRD,
    NpcID._100_JUBBLY_BIRD,
    NpcID.WILDERNESS_ENT,
    NpcID.WCGUILD_ENT,
    NpcID.SOULBANE_HOPE_MONST3,
    NpcID.SOULBANE_HOPE_MONST2,
    NpcID.BURGH_GADDERANKS_ATTACKABLE,
    NpcID.SWAMP_WALLBEAST_COMBAT,
    NpcID.WILDERNESS_RUNE_GOLEM,
    NpcID.WILDERNESS_GOLEM_RUNE_ROCK,
    NpcID.MUSPAH_FINAL_QUEST,
    NpcID.SHADOW_MAJ_BOUNCER,
    NpcID.NEWBIEGIANTRAT,
    NpcID.AGRITH_NAAR,
]);

/** Dead, uninteractable forms of attackable NPCs. */
const ALWAYS_DEAD: ReadonlySet<number> = new Set([
    NpcID.DRAKE_DEATH,
    NpcID.SUPERIOR_DRAKE_DEATH,
    NpcID.HYDRABOSS_FINALDEATH,
    NpcID.XARPUS_DEATH,
    NpcID.XARPUS_DEATH_STORY,
    NpcID.XARPUS_DEATH_HARD,
    NpcID.NIGHTMARE_DYING,
    NpcID.NIGHTMARE_CHALLENGE_DYING,
    NpcID.SLAYER_GARGOYLE_DEAD,
    NpcID.SUPERIOR_GARGOYLE_DEAD,
    NpcID.GARGBOSS_DAWN_DEATH,
    NpcID.GARGBOSS_DUSK_DEATH,
]);

/** Final forms that are alive again after a transformation (NpcUtil.onNpcChanged). */
export const RESET_DEAD_ON_CHANGE: ReadonlySet<number> = new Set([
    NpcID.KALPHITE_FLYINGQUEEN,
    NpcID.VETION_TRANS,
    NpcID.VETION_TRANS_SINGLE,
    NpcID.SHAPESHIFTERWOLF,
    NpcID.NZONE_SHAPESHIFTERWOLF_NORMAL,
    NpcID.NZONE_SHAPESHIFTERWOLF_HARD,
    NpcID.ZQ_MAINZOMBIE3,
    NpcID.NZONE_ZQ_MAINZOMBIE3_NORMAL,
    NpcID.NZONE_ZQ_MAINZOMBIE3_HARD,
    NpcID.KOLDEMON,
    NpcID.LOTR_TRAN_RAZORLOR_GHOST,
    NpcID.VIKING_ENEMY4,
    NpcID.FD_DAMIS_TOUGHER,
    NpcID.NZONE_FD_DAMIS_TOUGHER_NORMAL,
    NpcID.NZONE_FD_DAMIS_TOUGHER_HARD,
    NpcID.SOULBANE_HOPE_MONST1,
    NpcID.BURGH_GADDERANKS_WOUNDED,
    NpcID.NIGHTMARE_DEAD,
    NpcID.NIGHTMARE_CHALLENGE_DEAD,
    NpcID.CATA_BOSS_ALTAR_OPEN_N,
    NpcID.CATA_BOSS_ALTAR_OPEN_E,
    NpcID.CATA_BOSS_ALTAR_OPEN_S,
    NpcID.CATA_BOSS_ALTAR_OPEN_W,
    NpcID.SHADOW_MAJ_BOUNCER_CUTSCENE,
]);

/** Death animations that mark an NPC dead (NpcUtil.onAnimationChanged). */
export const DEATH_ANIMATIONS: ReadonlySet<number> = new Set([
    AnimationID.GRYPHON_BOSS_DEATH01,
    AnimationID.TOP_SPIDER_MAGIC_DEATH_DETONATE,
    AnimationID.TOP_SPIDER_RANGED_DEATH_DETONATE,
    AnimationID.TOP_SPIDER_MELEE_DEATH_DETONATE,
    AnimationID.TOB_SPIDER_TANK_DEATH,
    AnimationID.ELEMENTAL_DEATH,
]);

/** The corporeal beast also dies by animation, as it often dies with hitpoints left. */
export const CORP_DEATH = { npc: NpcID.CORP_BEAST, animation: AnimationID.CORPBEAST_DEATH };

/** What isDying needs to know about an NPC. */
export type NpcDeathFacts = {
    /** The NPC's current (transformed) type id. */
    id: number;
    /** Its transformed type's options, or undefined when it has no transformed type. */
    actions: ReadonlyArray<string | null | undefined> | undefined;
    /** The type's NPC_DEATH_HIDER_EXCLUDE param (0 when unset). */
    deathHiderExclude: number;
    /** RuneLite's NPC.isDead(): its health bar reached 0, or a death animation played. */
    dead: boolean;
    /** The last health ratio seen, or -1 without a health bar. */
    healthRatio: number;
};

/** RuneLite's NpcUtil.isDying, without the online runtime-config lists. */
export function isDying(npc: NpcDeathFacts): boolean {
    if (NEVER_DEAD.has(npc.id)) return false;
    if (ALWAYS_DEAD.has(npc.id)) return true;
    if (npc.id === NpcID.ZALCANO_WEAK) return npc.dead;
    if (npc.id === NpcID.AMOXLIATL) return npc.healthRatio === 0;
    if (!npc.actions) return false;
    if (!npc.actions.includes("Attack") || !npc.dead) return false;
    return npc.deathHiderExclude === 0;
}
