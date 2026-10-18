// RuneLite's Animation Smoothing filter (AnimationSmoothingPlugin.isAnimationInterpolatable):
// these sequences break when blended, whatever plays them. Kept apart from the plugin so the
// map worker, which bakes scenery animations, can read it too.
export const EXCLUDED_SEQUENCES: ReadonlySet<number> = new Set([
    6566, // dog_update_jackal_defend
    8266, // wyrm_walk
    8267, // wyrm_ready
    8270, // wyrm_attack_melee
    8271, // wyrm_attack_magic
    4652, // giant_update_basic_attack
    5530, // ghost_update_normal_ready
    5531, // ghost_update_normal_walk
    5583, // zombie_update_sign_walk
    6818, // duck_rework_underwater_ready_and_extra
    244, // wild_cave_chainmace_ready
    1051, // elemental_wheel_spin
    5857, // brain_mill_sail_rotate
    6495, // fai_varrock_millsail
    7898, // ds2_lithkren_generator_wheel
    9450, // waterwheel_chute
    8977, // human_spellcast_demonbane
    367, // poh_nexus
    3558, // burgh_bucket_drip
    4519, // keykeeper
    9493, // toa_sot_cast_b
    8499, // basilisk_knight_melee
    11291, // wgs_heroic_climb_success_two
]);

/** NPCs whose idle poses break when blended: the wyrm and the tree spirits. */
export const EXCLUDED_NPC_IDLES: ReadonlySet<number> = new Set([8610, 1163, 6380, 6319]);
