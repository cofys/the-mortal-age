/**
 * The Eclipse Moon's specials (docs/moons-of-peril.md), as captured; offsets are ticks into the
 * special, data specials.clones / specials.rays.
 *
 * Clones (Full Moon):
 * - 0: the Moon casts and a small circle marks the centre; 2: the player is thrown there and bound
 *   (Wiki); the Moon fades at 4 and leaves at 6.
 * - From 10: fifteen clones, five waves of three, a clone every 2 ticks and a wave every 9, each
 *   3 tiles from the Moon's tile in one of eight directions, facing the player. Three ticks after
 *   it rises a clone strikes. Facing it - attacking it, or clicking a tile its way, which turns the
 *   bound player without moving them - parries: the player's own attack goes back
 *   at once, at full accuracy, whatever their attack timer says - so slow, heavy weapons do best
 *   (Wiki). Otherwise the clone hits. The player's attacks land only through parries (their timer
 *   is held for the phase), only melee hurts the Moon, and every clone is in reach of the middle,
 *   diagonals too. A clone leaves 5 ticks after rising.
 * - 54: the circle goes, the Moon comes back and the player is free.
 * Searing Rays (New Moon):
 * - 0: the Moon casts and its shield rises at (+5, -2); 2: the player is thrown behind it.
 * - From 10 the shield walks the ring round the Moon, a leg of 7 tiles every 10 ticks (west,
 *   north, east, south), pausing at the corners.
 * - From 10, every 3 ticks: a ray. Behind the shield, it strikes the shield; otherwise the player,
 *   for minor damage and many blinding stacks (capture: about 9 and +9).
 * - 49: the shield sinks, and goes at 51.
 */
const Common = require("./Common.MoonsOfPeril");
const Cycle = require("./Cycle.MoonsOfPeril");
const Curses = require("./Curses.MoonsOfPeril");
const Pieces = require("./Pieces.MoonsOfPeril");

const clonesSpec = () => Common.data.specials.clones;
const raysSpec = () => Common.data.specials.rays;

// ------------------------------------------------------------------ Clones

/** When each clone rises: [offset, ...] for the 15 of them. */
function cloneTimes() {
  const s = clonesSpec();
  const times = [];
  for (let wave = 0; wave < s.waves; wave++) {
    for (let i = 0; i < s.perWave; i++) times.push(s.first + wave * s.waveEvery + i * s.gap);
  }
  return times;
}

function clonesStart(fight, offset) {
  const s = clonesSpec();
  fight.state.clones = [];
  fight.state.circle = Pieces.addLoc(fight, s.smallCircle, s.centre, { anim: s.circleAnims[0] });
  if (offset >= s.bindAt) bind(fight, offset);
}

function clonesTick(fight, offset) {
  const s = clonesSpec();
  if (offset === 1 && fight.state.circle) Common.locAnim(fight.player, fight.state.circle, s.circleAnims[1]);
  if (offset === s.bindAt) {
    Pieces.knockBack(fight, s.centre);
    bind(fight, offset);
  }
  if (cloneTimes().includes(offset)) raiseClone(fight);
  for (const clone of [...fight.state.clones]) {
    clone.age++;
    // Turned to the player again once it is in view (the add tick's own facing is lost).
    if (clone.age === 1 && clone.npc?.isRegistered?.()) clone.npc.setMobileInteraction(fight.player);
    if (clone.age === s.attackAfter) cloneStrike(fight, clone);
    if (clone.age === s.leaveAfter && clone.npc?.isRegistered?.()) Common.animate(clone.npc, s.leaveAnim);
    if (clone.age >= s.removeAfter) {
      Pieces.removeNpc(fight, clone.npc);
      fight.state.clones.splice(fight.state.clones.indexOf(clone), 1);
    }
  }
  if (offset === s.circleGoneAt) Pieces.removeLoc(fight, fight.state.circle);
}

/**
 * Bound in the middle (Wiki): walking turns the player to the clicked tile instead (bindWalk).
 * Only parries attack during the phase: the player's own swings wait it out.
 */
function bind(fight, offset) {
  const left = Math.max(1, clonesSpec().backAt - offset);
  fight.state.bound = true;
  fight.player.getMovementQueue().reset();
  fight.player.getCombat().setAttackDelay(left);
}

/** A walk click while bound: no step, just a turn to the tile, as a frozen player turns. */
function bindWalk(event) {
  const fight = Cycle.arenaOf("eclipse")?.fights.get(event.player);
  if (!fight?.state.bound) return;
  event.handled = true;
  const { player } = fight;
  const { x, y, z } = event.destination;
  player.getMovementQueue().reset();
  player.getCombat().clearInteraction(false);
  player.forcePositionToFace(new Common.core.Location(x, y, z));
  const here = player.getLocation();
  fight.state.faceDirection = [Math.sign(x - here.getX()), Math.sign(y - here.getY())];
}

function raiseClone(fight) {
  const s = clonesSpec();
  const direction = Common.pick(s.directions);
  const npc = Pieces.spawnNpc(fight, s.npc, direction, { anim: s.spawnAnim });
  if (!npc) return;
  npc.setMobileInteraction(fight.player);
  npc.setHitpointsLocked(true);
  npc.__moonClone = true;
  fight.state.clones.push({ npc, age: 0, direction: [Math.sign(direction[0]), Math.sign(direction[1])] });
}

/** Whether the player is facing the clone: attacking it, or turned its way by a walk click. */
function facing(fight, clone) {
  const { player } = fight;
  if (player.getCombat?.()?.getTarget?.() === clone.npc || player.getInteractingMobile?.() === clone.npc) return true;
  const turned = fight.state.faceDirection;
  return Boolean(turned) && !player.getInteractingMobile?.() && turned[0] === clone.direction[0] && turned[1] === clone.direction[1];
}

function cloneStrike(fight, clone) {
  const s = clonesSpec();
  if (!clone.npc?.isRegistered?.()) return;
  Common.animate(clone.npc, s.attackAnim);
  if (facing(fight, clone)) {
    parry(fight, clone.npc);
    return;
  }
  fight.hurt(Common.randomInt(0, s.unparriedMax));
}

/** The parry: the player's own attack goes straight back, past their attack timer. */
function parry(fight, npc) {
  const combat = fight.player.getCombat();
  if (combat.getTarget?.() !== npc) combat.attack(npc);
  fight.state.parrying = npc;
  try {
    combat.performNewAttack(true);
  } finally {
    fight.state.parrying = null;
  }
}

function clonesStop(fight) {
  Pieces.clear(fight);
  fight.state.clones = [];
  fight.state.bound = false;
  if (!fight.player.isRegistered()) return;
  fight.player.getCombat().setAttackDelay(0);
}

function clonesShared(arena, offset) {
  const s = clonesSpec();
  if (offset === 0) Common.animate(arena.npc, s.castAnim);
  if (offset === s.disappearAt) Common.animate(arena.npc, s.disappearAnim);
  if (offset === s.leaveAt) arena.setHidden(true);
  if (offset === s.backAt) {
    arena.setHidden(false);
    Common.animate(arena.npc, s.appearAnim);
  }
}

function clonesLanding(arena) {
  return Common.tileAt(arena.moon, clonesSpec().centre);
}

/** A hit on a clone is a hit on the Moon - melee only (Wiki) - at full accuracy. */
function hitClone(npc, hit) {
  const fight = npc?.__moonFight;
  if (!npc?.__moonClone || !fight) return false;
  const attacker = hit.getAttacker?.()?.getAsPlayer?.();
  const { CombatType } = Common.core;
  const damage = attacker === fight.player && hit.getCombatType?.() === CombatType.MELEE
    ? Curses.onPlayerHit(fight, hit)
    : 0;
  if (damage <= 0) {
    for (const part of hit.getHits()) part.setDamage(0);
    hit.updateTotalDamage();
    return true;
  }
  Common.sound(fight.player, fight.arena.spec.hitSound);
  fight.damage(damage);
  return true;
}

// ------------------------------------------------------------------ Searing Rays

function raysStart(fight, offset) {
  const s = raysSpec();
  fight.state.shield = { at: [...s.start], npc: Pieces.spawnNpc(fight, s.shield, s.start, { anim: s.spawnAnim }) };
  walkable(fight.state.shield.npc);
  Common.areaSound(fight.player, Common.tileAt(fight.moon, s.start), [s.spawnSound, 0], 15);
  fight.state.rays = [];
  // Joined part-way: the shield stands where its walk has taken it.
  if (offset > s.legsFrom) catchUpShield(fight, offset);
}

function catchUpShield(fight, offset) {
  const s = raysSpec();
  const shield = fight.state.shield;
  for (let tick = s.legsFrom; tick < offset; tick++) {
    const step = shieldStep(tick);
    if (step) shield.at = [shield.at[0] + step[0], shield.at[1] + step[1]];
  }
  if (shield.npc) {
    Pieces.removeNpc(fight, shield.npc);
    shield.npc = Pieces.spawnNpc(fight, s.shield, shield.at);
    walkable(shield.npc);
  }
}

/** The shield walks on the special's say, not the engine's. */
function walkable(npc) {
  if (!npc) return;
  npc.getMovementQueue().setBlockMovement(false);
  npc.setScriptedMovement?.(true);
}

/** The shield's step on this tick of the special, or null while it waits at a corner. */
function shieldStep(offset) {
  const s = raysSpec();
  if (offset < s.legsFrom) return null;
  const leg = Math.floor((offset - s.legsFrom) / s.legEvery);
  const into = (offset - s.legsFrom) % s.legEvery;
  if (leg >= s.path.length || into >= s.legSteps) return null;
  return s.path[leg];
}

function raysTick(fight, offset) {
  const s = raysSpec();
  const { player } = fight;
  if (offset === s.throwAt) {
    Pieces.knockBack(fight, s.throwTile);
    Pieces.addLoc(fight, s.blocker, s.blockerTile);
  }
  const step = shieldStep(offset);
  const shield = fight.state.shield;
  if (shield?.npc?.isRegistered?.()) shield.at = Common.offsetOf(fight.moon, shield.npc.getLocation());
  if (step && shield?.npc?.isRegistered?.()) shield.npc.getMovementQueue().walkStep(step[0], step[1]);
  if (offset >= s.rayFirst && offset <= s.rayUntil && (offset - s.rayFirst) % s.rayEvery === 0) {
    Common.sound(player, s.raySound);
    fight.state.rays.push({ in: 1 });
  }
  for (const ray of [...fight.state.rays]) {
    if (--ray.in > 0) continue;
    if (ray.hitting) {
      fight.state.rays.splice(fight.state.rays.indexOf(ray), 1);
      fight.hurt(Common.randomInt(1, s.max));
      Curses.add(fight, s.blind);
      continue;
    }
    fire(fight, ray);
  }
  if (offset === s.despawnAt && shield?.npc?.isRegistered?.()) {
    Common.animate(shield.npc, s.despawnAnim);
    Common.areaSound(player, Common.tileAt(fight.moon, shield.at), [s.despawnSound, 0], 15);
  }
  if (offset === s.removeAt) Pieces.clear(fight);
}

/** The ray leaves the Moon: into the shield if it stands between, else at the player. */
function fire(fight, ray) {
  const s = raysSpec();
  const { player } = fight;
  const centre = Common.tileAt(fight.moon, [2, 2]);
  const shield = fight.state.shield;
  if (shield?.npc?.isRegistered?.() && behindShield(fight)) {
    Common.projectile(player, centre, shield.npc, s.shieldProjectile);
    fight.state.rays.splice(fight.state.rays.indexOf(ray), 1);
    return;
  }
  Common.projectile(player, centre, player, s.playerProjectile);
  Common.sound(player, s.hitSound);
  ray.hitting = true;
  ray.in = s.hitAfter;
}

/** Whether the line from the Moon's centre to the player crosses the 2x2 shield. */
function behindShield(fight) {
  const [px, py] = Pieces.playerOffset(fight);
  const [sx, sy] = fight.state.shield.at;
  const from = [2.5, 2.5];
  const to = [px + 0.5, py + 0.5];
  let near = 0;
  let far = 1;
  for (let axis = 0; axis < 2; axis++) {
    const min = axis === 0 ? sx : sy;
    const max = min + 2;
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-9) {
      if (from[axis] < min || from[axis] > max) return false;
      continue;
    }
    let t1 = (min - from[axis]) / delta;
    let t2 = (max - from[axis]) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return false;
  }
  return true;
}

function raysStop(fight) {
  Pieces.clear(fight);
  fight.state.rays = [];
}

function raysShared(arena, offset) {
  const s = raysSpec();
  if (offset === 0) Common.animate(arena.npc, s.castAnim);
  if (offset >= s.rayFirst && offset <= s.rayUntil && (offset - s.rayFirst) % s.rayEvery === 0) {
    Common.animate(arena.npc, s.rayAnim);
    arena.npc.performGraphic(Common.graphic(s.raySpot.id, { delay: s.raySpot.delay }));
  }
}

function raysLanding(arena) {
  return Common.tileAt(arena.moon, raysSpec().throwTile);
}

// ------------------------------------------------------------------ hooks

function onHit({ npc, hit }) {
  hitClone(npc, hit);
}

/** The player's own clone, while they are bound in the middle. */
function ownClone(attacker, target) {
  const fight = target?.__moonClone ? target.__moonFight : null;
  return fight && attacker?.getAsPlayer?.() === fight.player ? fight : null;
}

/** Bound in the middle, every clone is in reach - the diagonal ones too (Wiki: one tile away works). */
function cloneReach(event) {
  if (ownClone(event.attacker, event.target)) event.distance = Math.max(event.distance, clonesSpec().reach);
}

/** A parry is undelayed (Wiki): it goes past the attack timer and leaves it as it was. */
function cloneTiming(event) {
  const fight = ownClone(event.attacker, event.target);
  if (!fight || fight.state.parrying !== event.target) return;
  event.ignoreDelay = true;
  event.keepDelay = true;
}

/** Each parry has full accuracy (Wiki). */
function cloneAccuracy(event) {
  const fight = ownClone(event.attacker, event.target);
  if (fight && fight.state.parrying === event.target) event.forceAccurate = true;
}

module.exports = function attachEclipseMoon(api) {
  Cycle.registerSpecial("clones", { name: "clones", start: clonesStart, tick: clonesTick, stop: clonesStop, shared: clonesShared, landing: clonesLanding });
  Cycle.registerSpecial("rays", { name: "rays", start: raysStart, tick: raysTick, stop: raysStop, shared: raysShared, landing: raysLanding });
  api.onNpcHitModify(onHit);
  api.onCombatAttackDistance(cloneReach);
  api.onAttackTiming(cloneTiming);
  api.onCombatHitRoll(cloneAccuracy);
  api.onWalkRoute(bindWalk);
};
