/**
 * What every Scurrius unit shares: the lair's tiles, the captured ids, and small helpers.
 * Facts and their sources are in docs/scurrius.md.
 */

/** Cache: rat_boss_normal (public, 1500 hp) and rat_boss_instance (solo, 500 hp). */
const PUBLIC_ID = 7221;
const SOLO_ID = 7222;
/** Cache: rat_boss_giant_rat, the summoned minion. */
const RAT_ID = 7223;
/** Cache: rat_boss_biologist, Historian Aldo (7226 Talk-to, or 7615 with Trade, by varbit 9586). */
const ALDO_ID = 12606;

/** The lair: its walls, so a player on any of its tiles is inside. */
const LAIR = Object.freeze({ minX: 3289, maxX: 3308, minY: 9858, maxY: 9877 });
/** Captured: every rockfall tile and rat lands on this floor. */
const FLOOR = Object.freeze({ minX: 3290, maxX: 3306, minY: 9860, maxY: 9875 });
/** Captured: Scurrius appears here, facing south. */
const SPAWN_TILE = Object.freeze([3301, 9867, 0]);
/** Captured: below 30% he walks back to the middle of the room. */
const CENTRE_TILE = Object.freeze([3298, 9867, 0]);
/**
 * Captured: the tile Scurrius stands on to eat from each food pile (north, east, south), and the
 * pile he faces while he eats (each pile is 2x2: north 3298,9876, east 3307,9867, south 3298,9858),
 * and the pile's side of him (he never steps off towards it).
 */
const FEEDING_SPOTS = Object.freeze([
  Object.freeze({ stand: [3297, 9873, 0], face: [3298, 9876, 0], pile: [0, 1] }),
  Object.freeze({ stand: [3304, 9866, 0], face: [3307, 9867, 0], pile: [1, 0] }),
  Object.freeze({ stand: [3298, 9860, 0], face: [3299, 9859, 0], pile: [0, -1] }),
]);
/** Captured landings: through the broken bars, and back out over the sewage water. */
const INSIDE_TILE = Object.freeze([3290, 9868, 0]);
const OUTSIDE_TILE = Object.freeze([3279, 9869, 0]);
/** Captured: Historian Aldo stands outside the bars, facing south. */
const ALDO_TILE = Object.freeze([3275, 9871, 0]);

/** Cache sequences (npc_rat_boss_*). */
const ANIM = Object.freeze({
  spawn: 10686,
  melee: 10693,
  ranged: 10694,
  feedingRanged: 10695,
  magic: 10696,
  feedingMagic: 10697,
  stomp: 10698,
  feedingStomp: 10699,
  feedingIdle: 10689,
  feedingSummon: 10703,
  death: 10705,
  /** Captured: the screech that brings the rats once he is below 30%. */
  enragedSummon: 10706,
});

/** Cache spotanims (vfx_rat_boss_*). */
const GFX = Object.freeze({
  magicCast: 2638,
  feedingMagicCast: 2639,
  magicProjectile: 2640,
  magicImpact: 2641,
  rangedProjectile: 2642,
  rangedImpact: 2643,
  debris: 2644,
});

/** Captured sounds. */
const SOUND = Object.freeze({
  magic: 7700,
  ranged: 7722,
  /** On the player as the bolt lands (a splash plays 227 instead) and as the fur ball does. */
  magicImpact: 7670,
  rangedImpact: 7696,
  /** sound_area at the room's middle with every stomp. */
  stomp: Object.freeze([7699, 7667]),
  /** sound_area on each debris tile: delay 240, range 5. */
  debris: 4175,
  /** sound_area with every rat call, eating or in the middle. */
  summon: 7717,
  climb: 7655,
});

/** Captured: Oh Rats! inside the lair, Scape Cave in the sewers. */
const MUSIC = Object.freeze({ lair: 777, sewers: 144 });

let api = null;
let core = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
}

const location = ([x, y, z]) => new core.Location(x, y, z);

function within(bounds, at) {
  if (!at || at.getZ?.() !== 0) return false;
  const x = at.getX();
  const y = at.getY();
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

const inLair = (at) => within(LAIR, at);

function isScurrius(npc) {
  const id = npc?.getId?.();
  return id === PUBLIC_ID || id === SOLO_ID;
}

const isPublic = (npc) => npc?.getId?.() === PUBLIC_ID;
const isRat = (npc) => npc?.getId?.() === RAT_ID;

/** Players fighting in the same room as `npc`: in the lair, on its side of the instance. */
function playersInRoom(npc) {
  const area = npc.getPrivateArea?.() ?? null;
  return npc.getPlayersWithinDistance(24).filter((player) =>
    player.getPrivateArea?.() === area && inLair(player.getLocation()) && player.getHitpoints() > 0);
}

/** Runs `action` after `ticks` game ticks; returns the task so it can be stopped. */
function later(ticks, action, key = null) {
  const task = new (class extends core.Task {
    constructor() {
      super(Math.max(1, ticks), key, false);
    }
    execute() {
      this.stop();
      action();
    }
  })();
  core.TaskManager.submit(task);
  return task;
}

module.exports = {
  PUBLIC_ID, SOLO_ID, RAT_ID, ALDO_ID,
  LAIR, FLOOR, SPAWN_TILE, CENTRE_TILE, FEEDING_SPOTS, INSIDE_TILE, OUTSIDE_TILE, ALDO_TILE,
  ANIM, GFX, SOUND, MUSIC,
  init, location, within, inLair, isScurrius, isPublic, isRat, playersInRoom, later,
  get api() { return api; },
  get core() { return core; },
};
