const { ObjectIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");
const { Anim } = require("../Constants.Agility");
const { JUMP_DOWN_SOUND, WALL_JUMP_SOUND } = require("../Steps.Agility");

/**
 * Rellekka Rooftop. Steps, sounds, tiles and ticks follow rsprox captures 1757, 1864 and 1885
 * (Leagues V, rev 227; no main-game recording), tiles walked from 1885. XP is the Wiki's.
 */
const HURDLE_SOUND = 1936;
const TIGHTROPE_SOUND = 2495;
const SIDESTEP_SOUND = 2451;

/** A run-up a tick after arriving, then the hurdle across, landing two ticks later. */
function runningLeap(object, index, landing, xp) {
  return {
    object,
    index,
    level: 80,
    xp,
    steps: ({ obj }) => [
      { face: [obj.x, obj.y] },
      { wait: 1 },
      { anim: Anim.RUN_UP, delay: 15 },
      { wait: 1 },
      { sound: HURDLE_SOUND },
      { move: landing, anim: Anim.JUMP_HURDLE, speed: [8, 50], ticks: 2 },
    ],
  };
}

module.exports = {
  key: "rellekka",
  name: "Rellekka Rooftop",
  helper: 19, // the Agility helper's course (enum 3507: "Rellekka Rooftops")
  lapXp: 780,
  petBase: 31063, // Giant squirrel base chance (Wiki)
  // 2/5 a lap; the hard Fremennik diary makes 1 cooldown in 3 two minutes (Wiki: Mark of Grace).
  marks: {
    level: 80,
    chance: 2 / 5,
    shortCooldown: [{ diary: "fremennik", tier: "hard", chance: 1 / 3 }],
    tiles: [
      [2622, 3676, 3], [2617, 3664, 3], [2618, 3660, 3], [2628, 3652, 3], [2628, 3655, 3], [2641, 3649, 3],
      [2643, 3651, 3], [2649, 3659, 3], [2644, 3662, 3], [2658, 3674, 3], [2656, 3681, 3],
    ],
  },
  obstacles: [
    {
      object: ObjectIds.ROUGH_WALL_6,
      index: 1,
      level: 80,
      xp: 20,
      steps: [{ wait: 1 }, { anim: Anim.CLIMB_UP, delay: 15 }, { wait: 2 }, { tele: [2625, 3676, 3] }, { anim: -1 }],
    },
    runningLeap(ObjectIds.GAP_31, 2, [2622, 3668, 3], 30),
    {
      object: ObjectIds.TIGHTROPE_10,
      index: 3,
      level: 80,
      xp: 40,
      route: [2622, 3658, 3],
      render: Anim.BALANCE_WALK,
      steps: [{ wait: 2 }, { sound: TIGHTROPE_SOUND, loops: 3 }, { walk: [[2626, 3654]] }],
    },
    {
      object: ObjectIds.GAP_32,
      index: 4,
      level: 80,
      xp: 85,
      route: [2629, 3655, 3],
      // A jump up onto the ledge, side-steps east along it, then a tightrope down to 2639,3653.
      steps: ({ obj }) => [
        { face: [obj.x, obj.y] },
        { wait: 1 },
        { sound: WALL_JUMP_SOUND, delay: 20 },
        { move: [2629, 3658], anim: Anim.JUMP_SHORT, delay: 20, speed: [25, 30], dir: "north" },
        { anim: Anim.LEDGE_STEP_OFF },
        { faceDir: "east" },
        { sound: SIDESTEP_SOUND, loops: 4 },
        { render: Anim.LEDGE_WALK_BACK },
        { wait: 1 },
        { walk: [[2633, 3658]] },
        { sound: SIDESTEP_SOUND, loops: 2, delay: 10 },
        { walk: [[2635, 3658]] },
        { render: Anim.BALANCE_WALK },
        { sound: TIGHTROPE_SOUND, loops: 4 },
        { walk: [[2639, 3654], [2639, 3653]] },
        { wait: 1 },
      ],
    },
    runningLeap(ObjectIds.GAP_33, 5, [2643, 3657, 3], 25),
    {
      object: ObjectIds.TIGHTROPE_11,
      index: 6,
      level: 80,
      xp: 105,
      route: [2647, 3662, 3],
      render: Anim.BALANCE_WALK,
      steps: [
        { wait: 1 },
        { face: [2648, 3663] },
        { wait: 1 },
        { sound: TIGHTROPE_SOUND, loops: 6 },
        { walk: [[2647, 3663], [2654, 3670], [2655, 3670]] },
        { wait: 1 },
      ],
    },
    {
      object: ObjectIds.PILE_OF_FISH,
      index: 7,
      level: 80,
      xp: 475,
      // The jump a tick after arriving and the landing, with the lap, a tick later; then a step west.
      steps: ({ obj }) => [
        { face: [obj.x, obj.y] },
        { wait: 1 },
        { anim: Anim.LEAP, delay: 15 },
        { sound: JUMP_DOWN_SOUND, delay: 15 },
        { wait: 1 },
        { tele: [2653, 3676, 0] },
        { anim: Anim.LAND },
        { complete: true },
        { wait: 1 },
        { walk: [[2652, 3676]] },
      ],
    },
  ],
};
