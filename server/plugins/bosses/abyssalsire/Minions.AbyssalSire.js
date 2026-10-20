/**
 * The Sire's spawns and scions (Wiki: Spawn, Scion), as captured:
 * - a spawn is thrown from the Sire's mouth (abyssal_spawn_projanim, its landing sound with it)
 *   and lands near the player 6 ticks later, attacking at once;
 * - spawns and scions hit with melee beside the player and ranged otherwise (dwarf_stone_throw
 *   for both), every 4 ticks: spawns 4/9, scions 10/16 (Wiki);
 * - a spawn not killed within 20 ticks (Wiki: 12 seconds) matures into a scion (abyssal_scion_spawn);
 * - a minion that can't attack the player for 50 ticks (Wiki: about 30 seconds) dies off;
 * - they all die with the Sire: their dying forms, death sequences and sound, gone 2 ticks later.
 * Killed by the player, they die as normal NPCs (npc-combat-defs) and drop their fiendish ashes.
 */
const Common = require("./Common.AbyssalSire");

/** Rings of tiles round the player a thrown spawn may land on (captured: 1-2 tiles off). */
const LANDING_REACH = 2;

let MinionMethod = null;

function minionMethod() {
  if (MinionMethod) return MinionMethod;
  const { Animation, CombatFactory, CombatMethod, CombatType, PendingHit, Projectile } = Common.core;
  MinionMethod = class extends CombatMethod {
    constructor(npc) {
      super();
      this.npc = npc;
      const target = npc?.getCombat?.()?.getTarget?.();
      this.melee = Boolean(target) && Common.distanceToFootprint(target.getLocation(), npc) <= 1;
    }

    type() {
      return this.melee ? CombatType.MELEE : CombatType.RANGED;
    }

    attackSpeed() {
      return Common.data.minions.attackTicks;
    }

    attackDistance() {
      return this.melee ? 1 : 7;
    }

    start(npc, target) {
      const { anims, projectiles, sounds } = Common.data;
      const scion = npc.getId() === Common.data.npcs.scion;
      const anim = scion ? (this.melee ? anims.scionMelee : anims.scionRanged) : anims.spawnAttack;
      npc.performAnimation(new Animation(anim));
      if (npc.__sireMinion) npc.__sireMinion.attackedAt = npc.__sireMinion.fight.tick;
      const watchers = npc.__sireMinion?.fight.watchers() ?? [];
      if (this.melee) {
        Common.areaSound(watchers, sounds.spawnAttack, npc.getLocation());
        return;
      }
      const spec = scion ? projectiles.scionRanged : projectiles.spawnRanged;
      new Projectile(Projectile.centreOf(npc), target.getLocation(), target, spec.id, spec.start, spec.end, spec.startHeight, spec.endHeight, null)
        .withAngle(spec.angle)
        .withProgress(spec.progress)
        .sendProjectile();
      Common.areaSound(watchers, sounds.spawnRangedAttack, npc.getLocation());
    }

    hits(npc, target) {
      const { minions, npcs } = Common.data;
      const maxes = npc.getId() === npcs.scion ? minions.scion : minions.spawn;
      const hit = new PendingHit(npc, target, this, this.melee ? 0 : 2);
      CombatFactory.applyStyleDamage(hit, this.melee ? maxes.melee : maxes.ranged);
      return [hit];
    }
  };
  return MinionMethod;
}

class Minions {
  constructor(fight) {
    this.fight = fight;
    this.all = new Set();
  }

  count() {
    for (const npc of [...this.all]) if (!npc.isRegistered() || npc.getHitpoints() <= 0) this.all.delete(npc);
    return this.all.size;
  }

  /** A walkable floor tile in the chamber. */
  open(tile) {
    const { RegionManager } = Common.core;
    return this.fight.lair.contains(tile) && !RegionManager.blocked(tile, null);
  }

  /** A tile near `centre`, `reach` tiles at most, that a spawn can stand on. */
  tileNear(centre, reach) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const tile = centre.transform(Common.randomInt(-reach, reach), Common.randomInt(-reach, reach));
      if (this.open(tile)) return tile;
    }
    return centre.clone();
  }

  throwSpawn(near) {
    const fight = this.fight;
    const { projectiles, sounds, minions } = Common.data;
    const { Projectile } = Common.core;
    const tile = this.tileNear(near, LANDING_REACH);
    const spec = projectiles.spawn;
    new Projectile(Projectile.centreOf(fight.sire), tile, null, spec.id, spec.start, spec.end, spec.startHeight, spec.endHeight, null)
      .withAngle(spec.angle)
      .withProgress(spec.progress)
      .sendProjectile();
    Common.areaSound(fight.watchers(), sounds.spawnLand, tile);
    fight.at(minions.landTicks, () => this.add(tile));
  }

  /** `count` spawns on and around the Sire (phase 3's panic and explosion). */
  spawnAround(count) {
    const fight = this.fight;
    const centre = Common.core.Projectile.centreOf(fight.sire);
    const reach = Math.ceil(fight.sire.getSize() / 2) + 1;
    for (let i = 0; i < count && this.count() < Common.data.phase3.minionCap; i++) this.add(this.tileNear(centre, reach));
  }

  add(tile) {
    const fight = this.fight;
    if (fight.stopped || fight.phase === "dead") return null;
    const npc = Common.api.spawnNpc({ id: Common.data.npcs.spawn, x: tile.getX(), y: tile.getY(), z: tile.getZ(), wanderRadius: 0 });
    if (!npc) return null;
    npc.__skipDefaultRespawn = true;
    npc.__sireLair = fight.lair;
    npc.__sireMinion = { fight, bornAt: fight.tick, attackedAt: fight.tick };
    npc.setMultiCombat?.(true);
    this.all.add(npc);
    if (fight.playerHere()) npc.getCombat().attack(fight.player);
    return npc;
  }

  tick() {
    const fight = this.fight;
    const { minions, npcs, anims } = Common.data;
    const { Animation } = Common.core;
    for (const npc of [...this.all]) {
      if (!npc.isRegistered() || npc.getHitpoints() <= 0) {
        this.all.delete(npc);
        continue;
      }
      const state = npc.__sireMinion;
      if (npc.getId() === npcs.spawn && !state.matured && fight.tick - state.bornAt >= minions.matureTicks) {
        state.matured = true;
        fight.stats.scionMatured = true;
        npc.setNpcTransformationId(npcs.scion);
        // A scion has its own hitpoints (Wiki: 50), not what the spawn had left.
        const hitpoints = npc.getCurrentDefinition().getHitpoints();
        npc.setMaxHitpoints(hitpoints);
        npc.setHitpoints(hitpoints);
        npc.performAnimation(new Animation(anims.scionSpawn));
      }
      if (fight.tick - state.attackedAt >= minions.idleDeathTicks) {
        this.die(npc);
        continue;
      }
      if (fight.playerHere() && npc.getCombat().getTarget() !== fight.player) npc.getCombat().attack(fight.player);
    }
  }

  /** A minion dies off (the Sire's death, or too long without a hit): no drop. */
  die(npc) {
    const { npcs, anims, sounds, minions } = Common.data;
    const { Animation } = Common.core;
    this.all.delete(npc);
    if (!npc.isRegistered()) return;
    const scion = npc.getId() === npcs.scion;
    npc.getCombat().reset?.();
    npc.setNpcTransformationId(scion ? npcs.scionDying : npcs.spawnDying);
    npc.setMobileInteraction(null);
    npc.performAnimation(new Animation(scion ? anims.scionDeath : anims.spawnDeath));
    Common.areaSound(this.fight.watchers(), sounds.spawnDeath, npc.getLocation());
    Common.later(minions.dyingTicks, () => Common.api.removeNpc(npc));
  }

  killAll() {
    for (const npc of [...this.all]) this.die(npc);
  }

  /** The fight ended without a kill: they just go. */
  removeAll() {
    for (const npc of [...this.all]) Common.api.removeNpc(npc);
    this.all.clear();
  }
}

function attachMinions(api) {
  const { npcs } = Common.data;
  api.registerNpcCombatMethodProvider([npcs.spawn, npcs.scion], minionMethod(), { singleton: false });
}

module.exports = Minions;
module.exports.attachMinions = attachMinions;
