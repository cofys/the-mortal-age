"use strict";

/**
 * A tormented demon's own attacks (Wiki: Tormented Demon, Fight overview and Strategies):
 * - melee, ranged (bone shards) or magic (a fireball), every 6 ticks, up to 31, one style at a
 *   time, opening with melee half the time and ranged or magic a quarter each (captured). It
 *   closes in to melee and holds back to cast or throw; if it can't reach the player
 *   to melee it switches to magic or ranged (Temple.TormentedDemons.js notices that);
 * - every 10th attack it binds the player for 2 ticks, turns their run off and throws two fire
 *   bombs, one at their tile and one at a random walkable tile beside it, landing 4 ticks on for
 *   40-45. It then drops its shield and always changes style;
 * - its first ranged or magic attack of a fight does a quarter of the damage (captured; Wiki ~75%
 *   less), unless a 5+ tick attack hit it while its shield was down;
 * - with two demons on a player, the second never melees and never attacks within a tick of the
 *   first (it is moved 3 ticks off when it would); a third and any more only throw single bombs.
 *
 * Every animation, graphic, projectile and sound, and the 8 ticks between the shield dropping
 * and its first attack, are as captured (Shared.TormentedDemons.js).
 */

const Shared = require("./Shared.TormentedDemons");

const {
  STYLES, SEQ, SPOT, PROJECTILE, HIT_DELAY, BOMB_TILE, SOUND, BIND_MESSAGE, ATTACK_SPEED, ATTACKS_PER_BOMB,
  BIND_TICKS, BOMB_LAND_TICKS, BOMB_DAMAGE, RANGED_DISTANCE,
} = Shared;

const STAGGER_TICKS = ATTACK_SPEED / 2;
const RUN_VARP = 173;
const ADJACENT = Object.freeze([[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]);
const RANGED_STYLES = Object.freeze(["ranged", "magic"]);

let MethodClass = null;

/** 0 for the demon that met the player first, 1 for the second, and so on. */
function roleOf(npc, player) {
  const order = Shared.demonsFighting(player);
  const index = order.indexOf(npc);
  return index < 0 ? order.length : index;
}

/** The style it attacks with now: a second demon on the player never melees. */
function styleFor(npc, fight, player) {
  if (fight.style === "melee" && player && roleOf(npc, player) === 1) fight.style = Shared.pick(RANGED_STYLES);
  return fight.style;
}

/** The demon takes on a player: it fights them until one of them leaves (Temple.TormentedDemons.js). */
function engage(fight, player) {
  if (fight.target === player) return;
  fight.target = player;
  fight.engagedAt = Shared.tick();
  fight.lostTargetAt = -1;
}

/**
 * Wiki: two demons on a player don't attack together, so the player can switch prayers between
 * them. A second demon about to attack within a tick of the first is moved 3 ticks off it.
 */
function keepStaggered(npc, player) {
  const order = Shared.demonsFighting(player);
  if (order.length < 2 || order[1] !== npc) return;
  const first = order[0].getCombat().getAttackDelay();
  // A first demon that is ready but not attacking (walking round, stalled) sets no beat.
  if (first === 0) return;
  const own = npc.getCombat().getAttackDelay();
  const gap = (own - first + ATTACK_SPEED) % ATTACK_SPEED;
  if (gap <= 1 || gap === ATTACK_SPEED - 1) npc.getCombat().setAttackDelay((first + STAGGER_TICKS) % ATTACK_SPEED);
}

function animate(npc, seq) {
  const { Animation } = Shared.core();
  npc.performAnimation(new Animation(seq));
}

function standardAttack(npc, player, style) {
  if (style === "melee") {
    animate(npc, SEQ.MELEE);
    Shared.spotanim(npc, SPOT.MELEE);
    Shared.sounds(player, SOUND.MELEE);
    return;
  }
  if (style === "ranged") {
    animate(npc, SEQ.RANGED);
    Shared.spotanim(npc, SPOT.RANGED_CAST);
    Shared.projectile(npc, player, PROJECTILE.RANGED);
    Shared.sounds(player, SOUND.RANGED_IMPACT);
    return;
  }
  animate(npc, SEQ.MAGIC);
  Shared.projectile(npc, player, PROJECTILE.MAGIC);
  Shared.spotanim(player, SPOT.MAGIC_IMPACT, PROJECTILE.MAGIC.end);
  Shared.sounds(player, SOUND.MAGIC_IMPACT);
}

function walkable(npc, tile) {
  const { RegionManager } = Shared.core();
  return !RegionManager.blocked(tile, npc.getPrivateArea());
}

/** A bomb thrown at a tile: it lands 4 ticks on and hurts the player if they still stand there. */
function throwBomb(npc, player, tile) {
  Shared.tileProjectile(npc, tile, PROJECTILE.BOMB);
  Shared.tileGraphic(npc, tile, BOMB_TILE.SHADOW.id, BOMB_TILE.SHADOW.delay);
  Shared.tileGraphic(npc, tile, BOMB_TILE.EXPLOSION.id, BOMB_TILE.EXPLOSION.delay);
}

/** After `ticks`, every bombed tile the player stands on hurts them (Wiki: even if the demon died). */
function landBombs(player, tiles, then) {
  const { Task, TaskManager } = Shared.core();
  const task = new Task(BOMB_LAND_TICKS, false);
  task.execute = () => {
    task.stop();
    if (player.isRegistered?.() !== false && player.getHitpoints() > 0) {
      const at = player.getLocation();
      if (tiles.some((tile) => tile.equals(at))) Shared.damage(player, Shared.randomInt(BOMB_DAMAGE[0], BOMB_DAMAGE[1]));
    }
    then?.();
  };
  TaskManager.submit(task);
}

function bindAndBomb(fight, player) {
  const npc = fight.npc;
  const { CombatFactory } = Shared.core();
  animate(npc, SEQ.EXPLOSION_FIRE);
  Shared.spotanim(npc, SPOT.BIND_CAST);
  Shared.projectile(npc, player, PROJECTILE.BIND);
  Shared.spotanim(player, SPOT.BIND_IMPACT);
  Shared.sounds(player, SOUND.BIND);
  CombatFactory.freeze(player, BIND_TICKS * 0.6, BIND_MESSAGE);
  const ran = player.isRunningReturn?.() === true;
  if (ran) {
    player.setRunning(false);
    player.getPacketSender().sendConfig(RUN_VARP, 0);
  }
  const here = player.getLocation().clone();
  const beside = ADJACENT.map(([x, y]) => here.transform(x, y)).filter((tile) => walkable(npc, tile));
  const tiles = beside.length > 0 ? [here, Shared.pick(beside)] : [here];
  for (const tile of tiles) throwBomb(npc, player, tile);
  landBombs(player, tiles, () => {
    // Wiki: run comes back on once the bombs are down.
    if (ran && player.isRegistered?.() !== false) {
      player.setRunning(true);
      player.getPacketSender().sendConfig(RUN_VARP, 1);
    }
  });
  // Wiki: the shield drops after every bomb, and the demon always changes style.
  require("./Shield.TormentedDemons").dropShield(fight, player, false);
  fight.style = Shared.pick(STYLES.filter((style) => style !== fight.style));
  if (fight.defenceless) {
    fight.defencelessUntilHit = true;
  } else {
    fight.defencelessAt = Shared.tick() + Shared.DEFENCELESS_TICKS;
  }
}

/** A third (or later) demon on the player throws one bomb an attack (Wiki). */
function singleBomb(npc, player) {
  animate(npc, SEQ.EXPLOSION_FIRE);
  Shared.sounds(player, SOUND.SINGLE_BOMB);
  const tile = player.getLocation().clone();
  throwBomb(npc, player, tile);
  landBombs(player, [tile]);
}

/** The first ranged or magic attack: a quarter of the damage (a protection prayer still stops it). */
function weaken(hit) {
  for (const part of hit.getHits()) part.setDamage(Math.floor((part.getDamage() * Shared.FIRST_ATTACK_DAMAGE_PERCENT) / 100));
  hit.updateTotalDamage();
}

function methodClass() {
  if (MethodClass) return MethodClass;
  const { CombatMethod, PendingHit, CombatType } = Shared.core();
  MethodClass = class TormentedDemonCombatMethod extends CombatMethod {
    constructor() {
      super();
      this.style = null;
      this.bomb = false;
    }

    type() {
      return this.style ? Shared.combatTypeOf(this.style) : CombatType.MELEE;
    }

    attackDistance(character) {
      const fight = Shared.fights.get(character);
      if (!fight) return 1;
      const player = fight.target;
      const style = player && roleOf(character, player) >= 2 ? "magic" : styleFor(character, fight, player);
      return style === "melee" ? 1 : RANGED_DISTANCE;
    }

    attackSpeed() {
      return ATTACK_SPEED;
    }

    start(character, target) {
      if (!target?.isPlayer?.()) return;
      const fight = Shared.fightOf(character);
      engage(fight, target);
      fight.attacks++;
      if (roleOf(character, target) >= 2) {
        this.bomb = true;
        singleBomb(character, target);
        return;
      }
      if (fight.attacks % ATTACKS_PER_BOMB === 0) {
        this.bomb = true;
        bindAndBomb(fight, target);
        return;
      }
      this.style = styleFor(character, fight, target);
      standardAttack(character, target, this.style);
    }

    hits(character, target) {
      if (this.bomb || !this.style) return [];
      const hit = new PendingHit(character, target, this, HIT_DELAY[this.style]);
      const fight = Shared.fights.get(character);
      if (fight && fight.attacks === 1 && this.style !== "melee" && !fight.slowUnshieldedHit) weaken(hit);
      return [hit];
    }
  };
  return MethodClass;
}

function attach(api) {
  api.registerNpcCombatMethodProvider([...Shared.DEMON_IDS], methodClass(), { singleton: false });
}

module.exports = { attach, engage, keepStaggered, roleOf, methodClass, _test: { styleFor, roleOf, weaken } };
