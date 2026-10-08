const { Anim } = require("../constants");

/**
 * Steps shared by the Colossal Wyrm courses (ColossalWyrmBasic.js, ColossalWyrmAdvanced.js).
 * From rsprox captures 1106 and 1108 (rev 237, a Leagues world, before the 2026 rework that made
 * both courses slower); tiles end on the termite markers (`varlamore_wyrm_agility_*_termites`),
 * which sit where each obstacle drops the player. See docs/agility-courses.md.
 */
const Loc = Object.freeze({
  START_LADDER: 55178, // varlamore_wyrm_agility_start_ladder_trigger
  ZIPLINE: 55179, // varlamore_wyrm_agility_end_zipline_trigger
  TIGHTROPE: 55180, // varlamore_wyrm_agility_balance_1_trigger
  BASIC_TIGHTROPE: 55184, // varlamore_wyrm_agility_basic_balance_1_trigger
  BASIC_ROPE: 55186, // varlamore_wyrm_agility_basic_monkeybars_1_trigger
  BASIC_LADDER: 55190, // varlamore_wyrm_agility_basic_ladder_1_trigger
  ADVANCED_LADDER: 55191, // varlamore_wyrm_agility_advanced_ladder_1_trigger
  ADVANCED_EDGE: 55192, // varlamore_wyrm_agility_advanced_jump_1_trigger
  ADVANCED_TIGHTROPE: 55194, // varlamore_wyrm_agility_advanced_balance_1_trigger
});

/** Wyrm course animations, by their gamevals. */
const WyrmAnim = Object.freeze({
  ZIPLINE_ON: 11650, // wyrm_agility_zipline_on
  LEDGE_WALK: 11653, // wyrm_agility_ledge_walk
  LEDGE_READY: 11654, // wyrm_agility_ledge_ready
  LEDGE_ON: 11655, // wyrm_agility_ledge_on
  LEDGE_OFF: 11656, // wyrm_agility_ledge_off
  LONGJUMP: 11657, // wyrm_agility_longjump
  ZIPLINE_CAPE_DRAG: 11659, // wyrm_agility_zipline_cape_drag
  TIGHTROPE_WOBBLE: 11665, // wyrm_agility_tightrope_wobble
  ZIPLINE_JUMP: 11666, // wyrm_agility_zipline_jump
  KNOCKDOWN: 11667, // wyrm_agility_knockdown_loop
  GET_UP: 534, // human_getup
  WALK_BACKWARDS: 820, // human_walk_b
});

const ROPE_SOUND = 2495;
const HURDLE_SOUND = 1936;
const LONGJUMP_SOUND = 9700;

/** What the player says at the rope's pauses (Wiki): one pause on the basic course, two on the advanced. */
const FIRST_PAUSE = ["*sigh*", "Boy, my hands are tired.", "Nice view."];
const SECOND_PAUSE = ["I wonder what I'll do next.", "I hope my next adventure is fun.", "Why can that anteater talk?"];

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

/** A tightrope walked to `end`, wobbling once at `wobbleAt` on the way. */
function tightrope(wobbleAt, end) {
  return [
    { sound: ROPE_SOUND, loops: 4 },
    { walk: [wobbleAt] },
    { anim: WyrmAnim.TIGHTROPE_WOBBLE },
    { sound: ROPE_SOUND, loops: 3 },
    { walk: [end] },
  ];
}

/** Hurdle-jumps through `tiles`, `gap` ticks apart. */
function hurdles(tiles, { gap = 3, speed = [20, 60], delay = 10 } = {}) {
  return tiles.flatMap((tile) => [
    { sound: HURDLE_SOUND, delay },
    { move: tile, anim: Anim.JUMP_HURDLE, delay, speed, ticks: gap },
  ]);
}

/**
 * Hand over hand along the rope to `end`, pausing at each of `pauses` to say one of that pause's
 * lines (the Wiki's).
 */
function ledge(pauses, end) {
  const steps = [{ anim: WyrmAnim.LEDGE_ON }, { sound: 2474 }, { sound: 2470, loops: 9 }, { render: WyrmAnim.LEDGE_WALK }];
  pauses.forEach(([tile, lines]) => {
    steps.push({ walk: [tile] }, { anim: WyrmAnim.LEDGE_READY }, { say: pick(lines) }, { wait: 2 });
  });
  steps.push({ walk: [end] }, { render: null }, { anim: WyrmAnim.LEDGE_OFF }, { sound: 2473 });
  return steps;
}

/** The zipline from the course's top to its far end, the jump off and the fall. */
function zipline() {
  const slide = [];
  for (let x = 1628; x <= 1644; x += 2) {
    slide.push({ move: [x, 2933, 2], speed: [0, 30], dir: "east", ticks: 1 });
  }
  return [
    { faceDir: "east" },
    { anim: WyrmAnim.ZIPLINE_ON },
    { sound: 2474 },
    { wait: 1 },
    { anim: WyrmAnim.ZIPLINE_CAPE_DRAG },
    { sound: 9702 },
    ...slide,
    { anim: WyrmAnim.ZIPLINE_JUMP },
    { sound: 2473 },
    { wait: 1 },
    { tele: [1644, 2933, 0] },
    { anim: WyrmAnim.KNOCKDOWN },
    { wait: 2 },
    { move: [1645, 2933, 0], anim: WyrmAnim.GET_UP, speed: [0, 30], ticks: 1 },
  ];
}

/** The zipline obstacle, the last of either course; `index` and `xp` are that course's. */
function ziplineObstacle(index, level, xp) {
  return { object: Loc.ZIPLINE, index, level, xp, route: [1625, 2933, 2], steps: zipline };
}

module.exports = { Loc, WyrmAnim, FIRST_PAUSE, SECOND_PAUSE, LONGJUMP_SOUND, tightrope, hurdles, ledge, ziplineObstacle };
