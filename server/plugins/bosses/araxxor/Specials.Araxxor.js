/**
 * Araxxor's three specials and the per-tick fight engine (acid pools, the
 * rolling acid ball, chasing drip pools).
 *
 * The special replaces every seventh attack and turns on the first egg's colour (Wiki:
 * every six standards, first at attack 7):
 *  - Acidic: the boss rears (11476), a ball (13676) rolls from its feet two tiles a tick
 *    leaving acid pools, burning anyone within two tiles for 4 venom, then bursts (11492)
 *    into nine splatters;
 *  - Mirrorback: the boss splatters acid (11478) onto nine tiles around the player;
 *  - Ruptura: the boss drips (11477) a pool onto the player's tile that chases them for six
 *    ticks.
 *
 * Pools (object 54148, shape 10) are the damage field: standing in acid hurts more the
 * longer you keep standing (Wiki; ramp values ours). The capture shows only one collapsing
 * graphic per pool, so pools are pooled objects on the private area, cleared on death.
 */
const Shared = require("./Shared.Araxxor");
const Minions = require("./Minions.Araxxor");

const SPECIAL_ANIMATION = Object.freeze({ ball: 11476, splatter: 11478, drip: 11477 });
const BALL_ANIMATION = 11491;
const BALL_BURST_ANIMATION = 11492;

const WALKABLE_MASK = 0x1280100;

let api = null;
let core = null;
let CombatFactory = null;

/** Live fights by boss NPC: pools, standing counters, the ball and drip follow-ups. */
const fights = new Map();

function later(ticks, target, execFunc) {
  class DelayedTask extends core.Task {
    constructor() {
      super(Math.max(1, ticks), target, false);
    }

    execute() {
      this.stop();
      execFunc();
    }
  }
  core.TaskManager.submit(new DelayedTask());
}

function alive(entity) {
  return !!entity?.isRegistered?.() && (entity.getHitpoints?.() ?? 1) > 0;
}

function getFight(npc) {
  let fight = fights.get(npc);
  if (!fight) {
    fight = {
      pools: new Map(),
      standing: new Map(),
      ball: null,
      ballTiles: 0,
      drips: [],
    };
    fights.set(npc, fight);
  }
  return fight;
}

function isWalkable(x, y) {
  return (core.RegionManager.getClipping(x, y, 0, null) & WALKABLE_MASK) === 0;
}

/**
 * One acid pool on the boss's private area. The fight tracks them by tile so the damage
 * tick can ask "is anyone standing in acid", and death clears them all.
 */
function spawnPool(npc, x, y) {
  const fight = getFight(npc);
  const key = Shared.tileKey(x, y);
  if (fight.pools.has(key)) return fight.pools.get(key);
  const area = npc.getPrivateArea?.() ?? null;
  if (area?.isDestroyed?.() === true) return null;
  const object = new core.GameObject(Shared.ACID_POOL_OBJECT, new core.Location(x, y, 0), 10, 0, area);
  core.ObjectManager.register(object, true);
  area?.add?.(object);
  fight.pools.set(key, object);
  return object;
}

/** Starts the Wiki hatch count: first egg after 3 standards, then every 6. Never
 * resets an in-progress fight (a stale cleanup rebuilding mid-battle). */
function initFight(npc) {
  const fight = getFight(npc);
  if (npc?.getAttribute?.(Shared.ATTR_STANDARDS) == null) npc.setAttribute(Shared.ATTR_STANDARDS, 0);
  if (npc?.getAttribute?.(Shared.ATTR_NEXT_HATCH) == null) npc.setAttribute(Shared.ATTR_NEXT_HATCH, Shared.FIRST_HATCH_STANDARDS);
  return fight;
}

/** Counts one non-special attack; hatches the next egg when its standard is due.
 * Overdamaged eggs despawn inside hatchNext, and the threshold still advances a
 * full interval, so the next egg waits another six standards (Wiki). */
function checkStandardHatch(npc) {
  if (!npc) return;
  const standards = (npc.getAttribute?.(Shared.ATTR_STANDARDS) ?? 0) + 1;
  npc.setAttribute(Shared.ATTR_STANDARDS, standards);
  const next = npc.getAttribute?.(Shared.ATTR_NEXT_HATCH) ?? Shared.FIRST_HATCH_STANDARDS;
  if (standards >= next) {
    npc.setAttribute(Shared.ATTR_NEXT_HATCH, next + Shared.HATCH_INTERVAL_STANDARDS);
    Minions.hatchNext(npc);
  }
}

function startSpecial(npc, target) {
  const kind = npc.getAttribute?.(Shared.ATTR_SPECIAL);
  if (!kind) return;
  npc.performAnimation(new core.Animation(SPECIAL_ANIMATION[kind] ?? SPECIAL_ANIMATION.ball));
  if (kind === "ball") {
    later(2, target, () => {
      // A corpse keeps 1 HP so players can walk to it: never start a ball off one.
      if (alive(npc) && npc.getAttribute?.(Shared.ATTR_DYING) !== true) startBall(npc, target);
    });
  } else if (kind === "splatter") {
    const pos = target?.getLocation?.();
    if (!pos) return;
    // Sprayed outward along the boss-to-player line (Wiki: random, in their direction).
    const centre = core.Projectile.centreOf(npc);
    const direction = { x: pos.getX() - centre.getX(), y: pos.getY() - centre.getY() };
    const tiles = Shared.splatterTiles(pos.getX(), pos.getY(), isWalkable, direction);
    throwBlobs(npc, tiles);
  } else if (kind === "drip") {
    startDrip(npc, target);
  }
}

/** A projectile for every tile; the pool grows where the blob lands. */
function throwBlobs(npc, tiles) {
  const areaDestroyed = () => npc.getPrivateArea?.()?.isDestroyed?.() === true;
  for (const [x, y] of tiles) {
    new core.Projectile(
      core.Projectile.centreOf(npc),
      new core.Location(x, y, npc.getLocation().getZ()),
      null,
      Shared.ACID_PROJECTILE,
      30,
      90,
      35,
      0,
      npc.getPrivateArea(),
    ).sendProjectile();
  }
  later(3, npc, () => {
    if (areaDestroyed()) return;
    // Captured: every blob bursts into the 2923 splat at ground height with the 4135
    // splash (MapAnim + SoundArea at the projectile's arrival) on the same tick the
    // pool object grows.
    const session = npc.getAttribute?.(Shared.ATTR_ENCOUNTER) ?? null;
    const viewer = session?.player ?? session?.fighter ?? null;
    const sender = viewer?.getPacketSender?.() ?? null;
    // Wiki: the splatter damages before the pool forms. Anyone standing on a landing
    // tile takes the impact; the boss herself never does (captures + venom immunity).
    const victims = npc.getPlayersWithinDistance?.(25) ?? [];
    for (const [x, y] of tiles) {
      if (sender) {
        const at = new core.Location(x, y, npc.getLocation().getZ());
        const impact = new core.Graphic(Shared.ACID_SPLAT_GFX);
        impact.height = 0;
        sender.sendGlobalGraphic(impact, at);
        sender.sendAreaSound(Shared.ACID_SPLAT_SOUND, x, y, at.getZ(), 1, 0, 2, 0);
      }
      for (const player of victims) {
        if (!alive(player)) continue;
        const pos = player.getLocation();
        if (pos.getX() !== x || pos.getY() !== y) continue;
        player.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(Shared.SPLAT_IMPACT_DAMAGE, core.HitMask.RED)]);
        if (player.isVenomed?.() !== true) {
          CombatFactory?.poisonEntity?.(player, 6, 2);
        }
      }
      spawnPool(npc, x, y);
    }
  });
}

/**
 * The rolling acid ball: two tiles a tick in the player's direction at the cast, an acid
 * pool under every tile it crosses, 4 venom to anyone within two tiles, and a nine-blob
 * burst when it stops (walls, or its range).
 */
function startBall(npc, target) {
  const fight = getFight(npc);
  if (fight.ball && alive(fight.ball)) return;
  const centre = core.Projectile.centreOf(npc);
  let x = centre.getX() - 1;
  let y = centre.getY();
  const pos = target?.getLocation?.();
  const dx = pos ? Math.sign(pos.getX() - x) : 0;
  const dy = pos ? Math.sign(pos.getY() - y) : 0;
  if (dx === 0 && dy === 0) return;
  const area = npc.getPrivateArea?.() ?? null;
  if (area?.isDestroyed?.() === true) return;
  const ball = core.NPC.create(Shared.BALL_ID, new core.Location(x, y, npc.getLocation().getZ()));
  ball.__skipDefaultRespawn = true;
  // The cache has no hitpoints for 13676 (-1); the tracker's alive() needs a positive one.
  ball.setHitpoints?.(1);
  // Rolls through bodies, notably the boss's own 7x7, instead of stalling on them.
  ball.setFlag?.(core.NPC.WALK_THROUGH_ENTITIES_FLAG, true);
  area?.add?.(ball);
  core.World.getAddNPCQueue().push(ball);
  fight.ball = ball;
  fight.ballTiles = 0;
  fight.ballDirection = { x: dx, y: dy };
}

function tickBall(npc, fight, players) {
  const ball = fight.ball;
  if (!ball) return;
  if (!ball.isRegistered?.() || (npc.getPrivateArea?.() ?? null)?.isDestroyed?.() === true) {
    fight.ball = null;
    return;
  }
  const location = ball.getLocation();
  spawnPool(npc, location.getX(), location.getY());
  for (const player of players) {
    if (!alive(player)) continue;
    const pos = player.getLocation();
    const distance = Math.max(Math.abs(pos.getX() - location.getX()), Math.abs(pos.getY() - location.getY()));
    if (distance <= 2) {
      player.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(Shared.BALL_DAMAGE, core.HitMask.RED)]);
      CombatFactory?.poisonEntity?.(player, 6, 2);
    }
  }
  const { x: dx, y: dy } = fight.ballDirection ?? { x: 0, y: 0 };
  const next = { x: location.getX() + dx, y: location.getY() + dy };
  fight.ballTiles += 1;
  if (fight.ballTiles >= Shared.BALL_ROLL_TILES || !isWalkable(next.x, next.y)) {
    ball.performAnimation(new core.Animation(BALL_BURST_ANIMATION));
    core.World.getRemoveNPCQueue().push(ball);
    fight.ball = null;
    throwBlobs(npc, Shared.splatterTiles(location.getX(), location.getY(), isWalkable));
    return;
  }
  ball.performAnimation(new core.Animation(BALL_ANIMATION));
  const step = new core.Location(next.x, next.y, ball.getLocation().getZ());
  const movement = ball.getMovementQueue?.();
  movement?.reset?.();
  movement?.addSteps?.(step);
  if (!movement?.addSteps) ball.moveTo?.(step);
}

/** The dripping pool: lands after the flight, then chases the player for six ticks. */
function startDrip(npc, target) {
  const pos = target?.getLocation?.();
  if (!pos) return;
  const from = core.Projectile.centreOf(npc);
  const distance = Math.max(1, from.getDistance(pos));
  // The pool must land with its blob: the packet's end time is delay + duration
  // (30 + 30 per tile), i.e. 1 + distance ticks after the cast.
  const delay = 1 + distance;
  new core.Projectile(
    from,
    new core.Location(pos.getX(), pos.getY(), npc.getLocation().getZ()),
    null,
    Shared.ACID_PROJECTILE,
    30,
    30 + 30 * distance,
    35,
    0,
    npc.getPrivateArea(),
  ).sendProjectile();
  const fight = getFight(npc);
  const landing = { x: pos.getX(), y: pos.getY() };
  later(delay, target, () => {
    if (!alive(npc) || npc.getAttribute?.(Shared.ATTR_DYING) === true
      || (npc.getPrivateArea?.() ?? null)?.isDestroyed?.() === true) return;
    const object = spawnPool(npc, landing.x, landing.y);
    if (object) fight.drips.push({ object, player: target, until: core.World.getProcessCycle() + Shared.DRIP_FOLLOW_TICKS });
  });
}

function tickDrips(npc, fight) {
  if (fight.drips.length === 0) return;
  const now = core.World.getProcessCycle();
  for (let index = fight.drips.length - 1; index >= 0; index--) {
    const drip = fight.drips[index];
    if (now >= drip.until || !alive(drip.player)) {
      fight.drips.splice(index, 1);
      continue;
    }
    const pos = drip.player.getLocation();
    const key = Shared.tileKey(pos.getX(), pos.getY());
    const currentKey = `${drip.object.getLocation().getX()},${drip.object.getLocation().getY()}`;
    if (key === currentKey) continue;
    core.ObjectManager.deregister(drip.object, true);
    fight.pools.delete(currentKey);
    const moved = spawnPool(npc, pos.getX(), pos.getY());
    if (moved) drip.object = moved;
    else fight.drips.splice(index, 1);
  }
}

/** Acid hurts more the longer a player keeps standing on it (Wiki). */
function tickPools(npc, fight, players) {
  for (const player of players) {
    if (!alive(player)) continue;
    const pos = player.getLocation();
    const key = Shared.tileKey(pos.getX(), pos.getY());
    const standing = fight.standing.get(player);
    if (!fight.pools.has(key)) {
      fight.standing.delete(player);
      continue;
    }
    const ticks = standing && standing.key === key ? standing.ticks + 1 : 1;
    fight.standing.set(player, { key, ticks });
    const damage = Shared.poolDamage(ticks);
    player.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(damage, core.HitMask.RED)]);
    // The pools inflict venom too (Wiki); applied once so an active venom keeps escalating.
    if (player.isVenomed?.() !== true) {
      CombatFactory?.poisonEntity?.(player, 6, 2);
    }
  }
}

function tick() {
  for (const [npc, fight] of fights) {
    // A freshly spawned boss sits in the add queue for a tick before it registers: that is
    // not a dead fight, and cleaning up here would drop its hatch clock.
    if (!alive(npc)) {
      if (!core.World.getAddNPCQueue().includes(npc)) {
        endFight(npc);
      }
      continue;
    }
    // A live encounter must never regenerate (the engine heals an NPC that has
    // not attacked for 20 s; Zulrah, Mad Angel and the Doom do the same).
    npc.getCombat?.().getLastAttack?.().reset?.();
    const players = npc.getPlayersWithinDistance(25);
    const session = npc.getAttribute?.(Shared.ATTR_ENCOUNTER) ?? null;
    if (session) Minions.ensureTargets(session);
    if (session) Minions.pinEggs(session);
    tickBall(npc, fight, players);
    tickDrips(npc, fight);
    tickPools(npc, fight, players);
  }
}

/**
 * A dying Acidic araxyte splashes acid onto nearby tiles (Wiki: "explode, splattering acid
 * on random squares within a 7x7 AoE surrounding it"; Near-Reality's nine blobs).
 */
function acidicAraxyteDied({ npc }) {
  if (npc?.getId?.() !== Shared.MINION_ID.acidic) return;
  const session = npc.getAttribute?.(Shared.ATTR_ENCOUNTER) ?? null;
  const boss = session?.npc ?? null;
  if (!boss || !alive(boss) || boss.getAttribute?.(Shared.ATTR_DYING) === true) return;
  const location = npc.getLocation();
  // Captured as 13 blobs (both transcripts), not the special's nine.
  const tiles = Shared.splatterTiles(location.getX(), location.getY(), null, null, Shared.ACIDIC_DEATH_SPLATTER_COUNT);
  const area = npc.getPrivateArea?.() ?? null;
  for (const [x, y] of tiles) {
    new core.Projectile(
      location,
      new core.Location(x, y, location.getZ()),
      null,
      Shared.ACID_PROJECTILE,
      30,
      90,
      35,
      0,
      area,
    ).sendProjectile();
  }
  later(3, npc, () => {
    if (!alive(boss) || boss.getAttribute?.(Shared.ATTR_DYING) === true
      || (boss.getPrivateArea?.() ?? null)?.isDestroyed?.() === true) return;
    for (const [x, y] of tiles) spawnPool(boss, x, y);
  });
}

function endFight(npc) {
  const fight = fights.get(npc);
  if (!fight) return;
  for (const object of fight.pools.values()) {
    core.ObjectManager.deregister(object, true);
  }
  fight.pools.clear();
  fight.standing.clear();
  fight.drips.length = 0;
  if (fight.ball?.isRegistered?.()) {
    core.World.getRemoveNPCQueue().push(fight.ball);
  }
  fight.ball = null;
  fights.delete(npc);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  CombatFactory = pluginApi.getCombatFactory();
  pluginApi.onNpcDeath(acidicAraxyteDied);
  class EngineTask extends core.Task {
    constructor() {
      super(1, null, false);
    }

    execute() {
      tick();
    }
  }
  core.TaskManager.submit(new EngineTask());
}

module.exports = {
  attach,
  initFight,
  checkStandardHatch,
  startSpecial,
  startBall,
  startDrip,
  acidicAraxyteDied,
  throwBlobs,
  spawnPool,
  tick,
  tickBall,
  tickDrips,
  tickPools,
  endFight,
  fights,
  _test: { SPECIAL_ANIMATION },
};
