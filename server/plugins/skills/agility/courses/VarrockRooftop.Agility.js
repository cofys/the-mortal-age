const { ObjectIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");
const { Anim } = require("../Constants.Agility");
const { gapJump, wallScramble, faceLoc, JUMP_DOWN_SOUND, WALL_JUMP_SOUND } = require("../Steps.Agility");

/**
 * Varrock Rooftop. Steps, sounds and ticks follow rsprox captures 339 and 3154 (rev 230 and 232,
 * main game); obstacle XP is the Wiki's, which the captured `helper_agility_add_xp` amounts match.
 */
const JUMP_SOUND = 2461;
const HURDLE_SOUND = 1936;
const HOLD_SOUND = 2459;
const SIDESTEP_SOUND = 2451;
/** The clothes line's creak, heard by everyone near it, as the player is halfway across. */
const CLOTHES_LINE_SOUND = 413;

/** Tiles the player hangs from while shimmying along the wall (obstacle 4). */
const WALL_HOLDS = [[3190, 3413], [3190, 3412], [3190, 3411], [3190, 3410]];

/**
 * The run-up, the jump onto the wall (3190,3414), a hold every two ticks, the last one at
 * 3190,3409, two side-steps along the ledge and the jump onto the next roof.
 */
function shimmyAlongWall() {
  const steps = [
    { move: [3193, 3416], anim: Anim.RUN_UP, delay: 15, speed: [15, 45], dir: "west" },
    { sound: WALL_JUMP_SOUND, delay: 20 },
    { move: [3190, 3414], anim: Anim.JUMP_SHORT, delay: 20, speed: [25, 30], dir: "west" },
  ];
  for (const hold of WALL_HOLDS) {
    steps.push({ sound: HOLD_SOUND, delay: 35 }, { move: hold, anim: Anim.HANG_SWING, speed: [34, 52], dir: "west", ticks: 2 });
  }
  steps.push(
    { sound: HOLD_SOUND, delay: 35 },
    { move: [3190, 3409], anim: Anim.HANG_SWING_QUICK, speed: [34, 52], dir: "west", ticks: 2 },
    { anim: Anim.LEDGE_TURN },
    { render: Anim.LEDGE_WALK },
    { wait: 1 },
    { sound: SIDESTEP_SOUND, loops: 2 },
    { walk: [[3190, 3408]] },
    { sound: SIDESTEP_SOUND, loops: 2 },
    { walk: [[3190, 3407]] },
    { render: null },
    { sound: WALL_JUMP_SOUND },
    { move: [3192, 3406], anim: Anim.JUMP, speed: [5, 30], dir: "east" },
    { tele: [3192, 3406, 3] },
    { wait: 1 },
  );
  return steps;
}

module.exports = {
  key: "varrock",
  name: "Varrock Rooftop",
  helper: 7, // the Agility helper's course (enum 3507: "Varrock Rooftops")
  lapXp: 269.7,
  petBase: 24410, // Giant squirrel base chance (Wiki)
  marks: {
    level: 30,
    tiles: [[3215, 3410, 3], [3195, 3416, 1], [3193, 3395, 3], [3222, 3402, 3], [3237, 3406, 3]],
  },
  obstacles: [
    {
      object: ObjectIds.ROUGH_WALL_3,
      index: 1,
      level: 30,
      xp: 13.5,
      steps: (context) => [
        faceLoc(context.obj),
        { wait: 1 },
        { anim: Anim.CLIMB_UP, delay: 15 },
        { wait: 2 },
        { tele: [3220, 3414, 3] },
        { anim: Anim.GRAB_LEDGE },
        { sound: WALL_JUMP_SOUND },
        { wait: 1 },
        { move: [3219, 3414], speed: [17, 26], dir: "west" },
      ],
    },
    {
      object: ObjectIds.CLOTHES_LINE,
      index: 2,
      level: 30,
      xp: 23,
      // Three jumps along the line: from 3214,3414 a tick after arriving, then one and three ticks later.
      steps: [
        { wait: 1 },
        { sound: JUMP_SOUND },
        { move: [3212, 3414], anim: Anim.JUMP, speed: [15, 30], dir: "west" },
        { sound: JUMP_SOUND, delay: 15 },
        { move: [3210, 3414], anim: Anim.JUMP, delay: 15, speed: [30, 45], dir: "west", ticks: 0 },
        { wait: 1 },
        { areaSound: CLOTHES_LINE_SOUND, at: [3211, 3414, 3], radius: 5 },
        { wait: 1 },
        { tele: [3210, 3414, 3] },
        { sound: JUMP_SOUND },
        { move: [3208, 3414], anim: Anim.JUMP, speed: [15, 30], dir: "west", ticks: 2 },
      ],
    },
    {
      object: ObjectIds.GAP_5,
      index: 3,
      level: 30,
      xp: 19,
      route: [3201, 3416, 3],
      steps: gapJump([3197, 3416, 1], { face: [3197, 3416] }),
    },
    {
      object: ObjectIds.WALL_14,
      index: 4,
      level: 30,
      xp: 28,
      route: [3194, 3416, 1],
      steps: shimmyAlongWall,
    },
    {
      object: ObjectIds.GAP_6,
      index: 5,
      level: 30,
      xp: 10,
      steps: ({ pos }) => [
        { face: [pos.x, pos.y - 3] },
        ...wallScramble([pos.x, pos.y - 3, 3], [pos.x, pos.y - 4, 3], "south"),
      ],
    },
    {
      object: ObjectIds.GAP_7,
      index: 6,
      level: 30,
      xp: 24.5,
      // A run-up a tick after arriving, the long leap a tick later, then a jump that grabs the balcony.
      steps: [
        { wait: 1 },
        { face: [3215, 3399] },
        { anim: Anim.RUN_UP },
        { wait: 1 },
        { sound: JUMP_SOUND, delay: 15 },
        { move: [3215, 3399], anim: Anim.TABLE_LEAP, delay: 15, speed: [20, 50], dir: "east", ticks: 2 },
        { sound: WALL_JUMP_SOUND },
        { move: [3217, 3399], anim: Anim.JUMP_SHORT, speed: [5, 10], dir: "east" },
        { anim: Anim.GRAB_LEDGE },
        { move: [3218, 3399], speed: [18, 27], dir: "east" },
      ],
    },
    {
      object: ObjectIds.GAP_8,
      index: 7,
      level: 30,
      xp: 4.5,
      route: [3232, 3402, 3],
      steps: gapJump([3236, 3403, 3], { face: [3236, 3403] }),
    },
    {
      object: ObjectIds.LEDGE,
      index: 8,
      level: 30,
      xp: 3.5,
      steps: ({ pos }) => [
        { wait: 1 },
        { sound: HURDLE_SOUND },
        { move: [pos.x, pos.y + 2, 3], anim: Anim.JUMP_HURDLE, speed: [8, 50], dir: "north", ticks: 2 },
      ],
    },
    {
      object: ObjectIds.EDGE,
      index: 9,
      level: 30,
      xp: 143.7,
      // A hop onto the edge, the jump down a tick later and the landing on the next, with the lap.
      steps: ({ pos }) => [
        { wait: 1 },
        { sound: JUMP_SOUND },
        { move: [pos.x, pos.y + 1, 3], anim: Anim.JUMP, speed: [15, 30], dir: "north" },
        { anim: Anim.LEAP, delay: 15 },
        { sound: JUMP_DOWN_SOUND, delay: 15 },
        { wait: 1 },
        { tele: [pos.x, pos.y + 2, 0] },
        { anim: Anim.LAND },
      ],
    },
  ],
};
