"use strict";

/**
 * Ids, timings and numbers for the Crash Site Cavern gorillas (docs/demonic-gorillas.md).
 * Animations, projectiles, graphics and sounds are from rsprox captures; the rules from the Wiki.
 */

/** Each demonic gorilla colour has one id per protection prayer (cache: headicon 0 / 1 / 2). */
const DEMONIC_FAMILIES = [
  { melee: 7144, ranged: 7145, magic: 7146 }, // mm2_demon_gorilla_1_*
  { melee: 7147, ranged: 7148, magic: 7149 }, // mm2_demon_gorilla_2_*
];
const DEMONIC_IDS = DEMONIC_FAMILIES.flatMap((family) => [family.melee, family.ranged, family.magic]);
/** The level 141 tortured gorillas (mm2_tortured_gorilla_1 / _2); the quest's level 142 ones only punch. */
const TORTURED_IDS = [7150, 7151];

const STYLES = ["melee", "ranged", "magic"];

const KINDS = {
  // Wiki: a style change after three missed hits; Tortured gorillas after four.
  demonic: { missesPerSwitch: 3, boulders: true, prays: true },
  tortured: { missesPerSwitch: 4, boulders: false, prays: false },
};

const ATTACK_SPEED = 5;
/** Not on the Wiki: how far it casts and throws from. */
const RANGED_DISTANCE = 7;
/** Not on the Wiki: ticks in Melee without reaching its target before it changes style. */
const UNREACHABLE_TICKS = 10;
const STYLE_CHANGE_SHOUT = "Rhaaaaaaa!";

// Wiki: it changes prayer after four damaging hits and 70 damage in styles it doesn't protect against.
const PRAYER_SWITCH_HITS = 4;
const PRAYER_SWITCH_DAMAGE = 70;

const SEQ = {
  punch: 7226, // demonic_gorilla_punch
  range: 7227, // demonic_gorilla_range
  magic: 7225, // demonic_gorilla_magic
  smashChest: 7228, // demonic_gorilla_smash_chest: the boulder, and each prayer change
  defend: 7224,
  death: 7229,
};

/** Projectiles as the capture logs them: cycles from the attack, heights as the client sees them. */
const RANGED = {
  projectile: 1302, // mm2_gorilla_stone
  delay: 46,
  cyclesPerTile: 5,
  startHeight: 80,
  endHeight: 0,
  angle: 5,
  progress: 64,
  impact: 1303, // mm2_gorilla_stonesplat, on the ground
  impactSound: 3191,
};
const MAGIC = {
  projectile: 1304, // mm2_gorilla_spell
  delay: 46,
  cyclesPerTile: 4,
  startHeight: 80,
  endHeight: 70,
  angle: 5,
  progress: 64,
  impact: 1305, // mm2_gorilla_spellsplat
  impactHeight: 70,
  castSound: 3529,
  impactSound: 3528,
};
const MELEE_SOUND = 3350;

/**
 * The boulder: it falls from above onto the target's tile (the projectile starts one tile to
 * its side) and lands 5 ticks later. Wiki: 33% of the current hitpoints of whoever stands
 * there (its max hit of 40 is a third of 120). How often it is thrown isn't on the Wiki.
 */
const BOULDER = {
  chance: 1 / 5,
  projectile: 856, // myarm_rock_roc_travel
  delay: 15,
  end: 150,
  startHeight: 600,
  endHeight: 10,
  angle: 10,
  progress: 64,
  landTicks: 5,
  impact: 305, // castlewars_catapult_splash
  impactHeight: 10,
  sound: 1444,
  soundRadius: 10,
};

const MONKEY_MADNESS_II = "monkey_madness_ii";

/** The Crash Site Cavern. */
const CAVERN = { minX: 2050, maxX: 2167, minY: 5640, maxY: 5695, z: 0 };

module.exports = {
  DEMONIC_FAMILIES, DEMONIC_IDS, TORTURED_IDS, STYLES, KINDS, ATTACK_SPEED, RANGED_DISTANCE,
  UNREACHABLE_TICKS, STYLE_CHANGE_SHOUT, PRAYER_SWITCH_HITS, PRAYER_SWITCH_DAMAGE, SEQ, RANGED,
  MAGIC, MELEE_SOUND, BOULDER, MONKEY_MADNESS_II, CAVERN,
};
