const { ObjectIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");
const { Anim } = require("../Constants.Agility");
const { gapJump, wallScramble, JUMP_DOWN_SOUND } = require("../Steps.Agility");

/**
 * Canifis Rooftop. Steps, sounds and ticks follow rsprox captures 90, 91 and 1135 (Leagues V and
 * VI, rev 227 and 237; no main-game recording). XP is the Wiki's.
 */
const TREE_SOUND = 1705;

/** A gap: the rooftop jump, landing a tick later (see `gapJump`). */
function gap(object, index, route, landing, xp, { settle = 1 } = {}) {
  return {
    object,
    index,
    level: 40,
    xp,
    route,
    steps: gapJump(landing, { settle }),
  };
}

module.exports = {
  key: "canifis",
  name: "Canifis Rooftop",
  helper: 10, // the Agility helper's course (enum 3507: "Canifis Rooftops")
  lapXp: 240,
  petBase: 36842, // Giant squirrel base chance (Wiki)
  // 2/3 a lap, and no overlevel cut: a coding error in the game (Wiki: Mark of Grace).
  marks: {
    level: 40,
    chance: 2 / 3,
    overlevelPenalty: false,
    tiles: [[3499, 3505, 2], [3488, 3500, 2], [3476, 3494, 3], [3478, 3483, 2], [3497, 3471, 3], [3514, 3478, 2]],
  },
  obstacles: [
    {
      object: ObjectIds.TALL_TREE_2,
      index: 1,
      level: 40,
      xp: 10,
      route: [3508, 3488, 0],
      // Onto the tree's east end and up it, on the roof six ticks after the climb starts.
      steps: [
        { wait: 1 },
        { anim: Anim.CLIMB_TREE, delay: 60 },
        { sound: TREE_SOUND, delay: 60 },
        { move: [3508, 3489], speed: [30, 60], dir: "north", ticks: 2 },
        { move: [3505, 3489], speed: [60, 115], dir: "east", ticks: 0 },
        { wait: 4 },
        { tele: [3506, 3492, 2] },
      ],
    },
    {
      object: ObjectIds.GAP_9,
      index: 2,
      level: 40,
      xp: 8,
      route: [3505, 3497, 2],
      // A step's run-up a tick after arriving, then the jump.
      steps: [
        { wait: 1 },
        { move: [3505, 3498], anim: Anim.RUN_UP, delay: 20, speed: [20, 40], dir: "north" },
        { anim: Anim.LEAP, delay: 15 },
        { sound: JUMP_DOWN_SOUND, delay: 15 },
        { wait: 1 },
        { tele: [3502, 3504, 2] },
        { anim: Anim.LAND },
        { wait: 1 },
      ],
    },
    gap(ObjectIds.GAP_10, 3, [3498, 3504, 2], [3493, 3504, 2], 8, { settle: 2 }),
    {
      object: ObjectIds.GAP_13,
      index: 4,
      level: 40,
      xp: 10,
      route: [3487, 3499, 2],
      steps: [
        { face: [3479, 3499] },
        ...wallScramble([3481, 3499], [3479, 3499], "west"),
        { tele: [3479, 3499, 3] },
      ],
    },
    gap(ObjectIds.GAP_11, 5, [3478, 3493, 3], [3478, 3486, 2], 8),
    {
      object: ObjectIds.POLE_VAULT,
      index: 6,
      level: 40,
      xp: 10,
      route: [3478, 3486, 2],
      // A run-up, the vault over the pole a tick later, a tile a tick down to 3487,3476 and the
      // landing on the roof beyond. Tiles are the server's positions in the captures.
      steps: [
        { wait: 1 },
        { move: [3478, 3485], anim: Anim.RUN_UP, speed: [0, 30], dir: "east" },
        { move: [3482, 3481], anim: Anim.POLE_VAULT, speed: [0, 30], dir: "east" },
        { move: [3483, 3480], speed: [0, 30], dir: "east" },
        { move: [3484, 3479], speed: [0, 30], dir: "east" },
        { move: [3485, 3478], speed: [0, 30], dir: "east" },
        { move: [3486, 3477], speed: [0, 30], dir: "east" },
        { move: [3487, 3476], speed: [0, 28], dir: "east" },
        { tele: [3489, 3476, 3] },
        { anim: Anim.LAND },
      ],
    },
    gap(ObjectIds.GAP_12, 7, [3502, 3476, 3], [3510, 3476, 2], 11),
    gap(ObjectIds.GAP_14, 8, [3510, 3482, 2], [3510, 3485, 0], 175),
  ],
};
