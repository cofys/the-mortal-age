"use strict";

/**
 * The arena's clickable obstacles. They are one-tile-thick lines between the pillars, so a click
 * crosses one step: the animation plays, the player is force-moved past the clicked tile and the
 * Wiki's XP is paid when they land. The rope swing is the exception: it swings the player from
 * two tiles before the rope to three past it, as rsprox captures show. Blade and trap obstacles
 * have no click option; the Area unit handles those.
 */

const Shared = require("./Shared.BrimhavenAgilityArena");
const ObstacleRunner = require("../../skills/agility/ObstacleRunner.Agility");

/** Animation ids as server/plugins/skills/agility/Constants.Agility.js names them. */
const ANIM = {
  BALANCE_WALK: 762,
  LEDGE_WALK: 756,
  MONKEY_BARS_CROSS: 744,
  CLIMB_LOW_WALL: 839,
  ROPE_SWING: 751,
  JUMP: 741,
  HANG_SWING: 1122,
};
/** The rope swing's own animation, sound and how far past the rope it lands (rsprox captures). */
const ROPE_SWING = { ROPE_ANIM: 497, SOUND: 2494, PAST: 3, BEFORE: 2 };
/** 0 west, 1 north, 2 east, 3 south, as the agility steps' wall facings. */
const ROTATION_VECTORS = [[-1, 0], [0, 1], [1, 0], [0, -1]];

const SPECS = {
  BALANCING_ROPE: { anim: ANIM.BALANCE_WALK, render: ANIM.BALANCE_WALK },
  LOG_BALANCE: { anim: ANIM.BALANCE_WALK, render: ANIM.BALANCE_WALK },
  BALANCING_LEDGE: { anim: ANIM.LEDGE_WALK, render: ANIM.LEDGE_WALK },
  MONKEY_BARS: { anim: ANIM.MONKEY_BARS_CROSS },
  LOW_WALL: { anim: ANIM.CLIMB_LOW_WALL },
  ROPE_SWING: { anim: ANIM.ROPE_SWING },
  PLANK: { anim: ANIM.BALANCE_WALK, render: ANIM.BALANCE_WALK },
  PILLAR: { anim: ANIM.JUMP },
  HAND_HOLDS: { anim: ANIM.HANG_SWING },
};

/** objectId -> obstacle family key. */
const FAMILY = new Map();
for (const [kind, ids] of Object.entries(Shared.OBSTACLE_IDS)) {
  for (const id of ids) FAMILY.set(id, kind);
}

function familyAt(objectId) {
  return FAMILY.get(objectId) ?? null;
}

function obstacleXp(kind) {
  return Shared.OBSTACLE_XP[kind] ?? 0;
}

/**
 * `past` steps beyond the clicked tile, away from where the player stood. With `alongFace`, the
 * crossing runs across the loc's facing (the rope swings: rotation 0/2 swing north-south, 1/3
 * east-west in the cache), so a diagonal click still picks the swing's own axis.
 */
function crossingTarget(player, object, past = 1, alongFace = false) {
  const at = object.getLocation();
  const pos = player.getLocation();
  let dx = at.getX() - pos.getX();
  let dy = at.getY() - pos.getY();
  if (alongFace) {
    const [ax, ay] = ROTATION_VECTORS[((object.getFace?.() ?? 0) + 1) & 3];
    const side = Math.sign(dx * ax + dy * ay) || 1;
    return { x: at.getX() + ax * side * past, y: at.getY() + ay * side * past, z: at.getZ() };
  }
  if (dx === 0 && dy === 0) {
    const [fx, fy] = ROTATION_VECTORS[(object.getFace?.() ?? 0) & 3];
    return { x: at.getX() + fx * past, y: at.getY() + fy * past, z: at.getZ() };
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    dx = Math.sign(dx);
    dy = 0;
  } else {
    dx = 0;
    dy = Math.sign(dy);
  }
  return { x: at.getX() + dx * past, y: at.getY() + dy * past, z: at.getZ() };
}

/** One swing, the tick after arriving: a 5-tile exact move, the rope animating with it. */
function ropeSwingSteps(target) {
  return [
    { anim: ANIM.ROPE_SWING, delay: 5 },
    { objAnim: ROPE_SWING.ROPE_ANIM },
    { sound: ROPE_SWING.SOUND, delay: 5 },
    { move: [target.x, target.y, target.z], speed: [30, 55], ticks: 2 },
  ];
}

function useObstacle(event) {
  const kind = familyAt(event.objectId);
  if (!kind) return false;
  const player = event.player;
  if (ObstacleRunner.isBusy(player)) return true;
  const object = event.object;
  const at = object.getLocation();
  const spec = SPECS[kind];
  const target = kind === "ROPE_SWING"
    ? crossingTarget(player, object, ROPE_SWING.PAST, true)
    : crossingTarget(player, object);
  const context = {
    player,
    object,
    core: Shared.core(),
    obj: {
      x: at.getX(), y: at.getY(), z: at.getZ(),
      face: object.getFace?.() ?? 0, type: object.getType?.() ?? 10, id: event.objectId,
    },
    pos: (() => {
      const pos = player.getLocation();
      return { x: pos.getX(), y: pos.getY(), z: pos.getZ() };
    })(),
  };
  // ponytail: a click crosses one tile; repeated clicks walk a long rope/log, each paying XP.
  const steps = kind === "ROPE_SWING" ? ropeSwingSteps(target) : [
    { anim: spec.anim },
    { wait: 1 },
    { move: [target.x, target.y, target.z], anim: spec.anim, ticks: 1 },
  ];
  ObstacleRunner.run(context, steps, {
    render: spec.render ?? null,
    onFinish: (completed) => {
      if (completed) Shared.addXp(player, obstacleXp(kind));
    },
  });
  return true;
}

/**
 * Clicks from far away walk to the obstacle first; the obstacle claims only its own tiles. The
 * rope hangs over a gap nobody can stand in, so the rope swing is walked to two tiles before it
 * on the player's side, where the captures show players arriving.
 */
function routeToObstacle(event) {
  if (event.clickType !== 1 || !familyAt(event.objectId)) return;
  const at = event.object.getLocation();
  if (familyAt(event.objectId) === "ROPE_SWING") {
    event.destination = crossingTarget(event.player, event.object, -ROPE_SWING.BEFORE, true);
    return;
  }
  event.destination = { x: at.getX(), y: at.getY(), z: at.getZ() };
}

module.exports = (api) => {
  ObstacleRunner.init(api);
  api.onObjectInteraction("Balancing rope", { "Walk-on": useObstacle });
  api.onObjectInteraction("Log balance", { "Walk-on": useObstacle });
  api.onObjectInteraction("Balancing ledge", { "Walk-across": useObstacle });
  api.onObjectInteraction("Monkey bars", { "Swing-across": useObstacle });
  api.onObjectInteraction("Low wall", { "Climb-over": useObstacle });
  api.onObjectInteraction("Rope swing", { "Swing-on": useObstacle });
  api.onObjectInteraction("Plank", { "Walk-on": useObstacle });
  api.onObjectInteraction("Pillar", { "Jump-on": useObstacle });
  api.onObjectInteraction("Hand holds", { "Climb-across": useObstacle });
  api.onObjectRoute(routeToObstacle);
};

module.exports.useObstacle = useObstacle;
module.exports.routeToObstacle = routeToObstacle;
module.exports.crossingTarget = crossingTarget;
module.exports.ropeSwingSteps = ropeSwingSteps;
module.exports.familyAt = familyAt;
module.exports.obstacleXp = obstacleXp;
