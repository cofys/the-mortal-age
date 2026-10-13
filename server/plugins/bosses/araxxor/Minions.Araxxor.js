/**
 * Eggs and the three araxytes: hatching, minion attacks, the Mirrorback's damage reflection
 * and the Ruptura's burst.
 *
 * As captured / Near-Reality: eggs settle with 11506, hatch on the fight's standard
 * count (Wiki: first after 3 standards, then every 6) into a fresh minion at the egg's
 * tile (hatch mark 2927/2928/2929 + 11503), which walks to the centre and starts attacking 3 ticks later. Acidic spits (11498,
 * projectile 2925), Mirrorback melees (11500) and reflects half of every non-halberd,
 * non-ranged, non-magic hit back at its attacker, Ruptura never attacks: it runs at its
 * target and bursts (11510) for up to 49, hurting Araxxor 80/64 by distance as well
 * (captured: the boss took an 80 from a burst).
 *
 * Eggs and araxytes: the Wiki's max-hit setups (noxious halberd, crush style at top
 * accuracy, heavy ranged) always max-hit hatched araxytes, while unhatched eggs roll
 * normally; eggs keep their remaining health when they hatch (Wiki strategy: hitting
 * the eggs weakens the spiders).
 */
const Shared = require("./Shared.Araxxor");

let api = null;
let core = null;
let BonusManager = null;

const HATCH_ANIMATION = 11503;
const EGG_ANIMATION = 11506;
const EGG_DEATH_ANIMATION = 11508;
const RUPTURA_ANIMATION = 11510;
const RUPTURA_BURST_ATTRIBUTE = "araxxor:ruptura-burst";
const INSTANT_KILL_WEAPONS = ["noxious halberd", "crossbow", "ballista"];

function alive(entity) {
  return !!entity?.isRegistered?.() && (entity.getHitpoints?.() ?? 1) > 0;
}

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

function sessionOf(npc) {
  return npc?.getAttribute?.(Shared.ATTR_ENCOUNTER) ?? null;
}

/** The nine eggs of the fight, one per pattern tile. */
function spawnEggs(session) {
  const area = session.npc.getPrivateArea?.() ?? null;
  for (let index = 0; index < session.pattern.length; index++) {
    const type = session.pattern[index];
    const [x, y] = Shared.EGG_TILES[index];
    const egg = core.NPC.create(Shared.EGG_ID[type], new core.Location(x, y, 0));
    egg.__skipDefaultRespawn = true;
    egg.setHitpoints?.(Shared.EGG_HITPOINTS);
    // Eggs sit where they were laid: the radius stops wandering, and scripted
    // movement stops the retaliation chase (Combat keeps pursuing transient
    // denials like a canPursue refusal, so the flag is what actually pins them).
    egg.getMovementCoordinator?.().setRadius?.(0);
    egg.setScriptedMovement?.(true);
    egg.performAnimation(new core.Animation(EGG_ANIMATION));
    egg.setAttribute?.(Shared.ATTR_ENCOUNTER, session);
    area?.add?.(egg);
    core.World.getAddNPCQueue().push(egg);
    session.eggs.push({ type, x, y, npc: egg });
  }
}

/** Hatches the next living egg in the pattern on the fight's hatch beat. */
function hatchNext(bossNpc) {
  const session = sessionOf(bossNpc);
  if (!session || bossNpc.getAttribute?.(Shared.ATTR_DYING) === true) return;
  const entry = session.eggs.find((egg) => alive(egg.npc) && egg.npc.getId() === Shared.EGG_ID[egg.type]);
  if (!entry) return;
  const remaining = entry.npc.getHitpoints?.() ?? Shared.EGG_HITPOINTS;
  core.World.getRemoveNPCQueue().push(entry.npc);
  // Overdamaged eggs despawn instead of hatching (Wiki): the next egg waits a full beat.
  if (remaining <= Shared.EGG_HITPOINTS - Shared.MINION_HITPOINTS) {
    return;
  }
  const area = bossNpc.getPrivateArea?.() ?? null;
  if (area?.isDestroyed?.() === true) return;
  const minion = core.NPC.create(Shared.MINION_ID[entry.type], new core.Location(entry.x, entry.y, 0));
  minion.__skipDefaultRespawn = true;
  minion.setHitpoints?.(Math.max(1, remaining));
  minion.performAnimation(new core.Animation(HATCH_ANIMATION));
  minion.performGraphic(new core.Graphic(Shared.HATCH_GFX[entry.type]));
  minion.setAttribute?.(Shared.ATTR_ENCOUNTER, session);
  minion.setFlag?.(core.NPC.WALK_THROUGH_ENTITIES_FLAG, true);
  // Like Vorkath's spawn: a roaming radius, so the engine's pursuit actually walks it in.
  minion.getMovementCoordinator?.().setRadius?.(30);
  minion.setMultiCombat?.(true);
  area?.add?.(minion);
  core.World.getAddNPCQueue().push(minion);
  session.minions.push(minion);
  const target = session.fighter ?? null;
  if (target) {
    // Captured: the hatchling holds for three ticks, then goes for the player; the engine's
    // own pursuit walks it in (through bodies, flag above), like Vorkath's spawn.
    later(3, minion, () => {
      if (!alive(minion) || !alive(target)) return;
      minion.setTarget?.(target);
      minion.getCombat?.().attack?.(target);
    });
  }
}

/** Points every idle araxyte back at the fighter: hatching with no target, a dead
 * target, or a stalled pursuit must never leave a minion wandering its radius.
 * Only engages while the fighter is alive in the same instance; engaged minions
 * are untouched so attack delays are never reset. */
function ensureTargets(session) {
  const fighter = session?.fighter ?? null;
  if (!fighter || !alive(fighter)) return;
  if (session.area != null && fighter.getPrivateArea?.() !== session.area) return;
  for (const minion of session.minions ?? []) {
    if (!alive(minion)) continue;
    minion.getCombat?.().getLastAttack?.().reset?.();
    const current = minion.getCombat?.().getTarget?.() ?? null;
    if (current && alive(current)) continue;
    minion.setTarget?.(fighter);
    minion.getCombat?.().attack?.(fighter);
  }
}

/**
 * Eggs neither move nor turn: retaliation keeps handing them a mobile
 * interaction (which the client renders as turning to face the attacker as
 * they walk), so the fight engine clears it and the combat target every tick.
 */
function pinEggs(session) {
  for (const entry of session?.eggs ?? []) {
    const egg = entry?.npc ?? null;
    if (!egg?.isRegistered?.()) continue;
    if (egg.getInteractingMobile?.() != null) egg.setMobileInteraction?.(null);
    egg.getCombat?.().reset?.();
    // Eggs never attack, so the engine would always see their last attack as
    // ancient and heal them; keep the stopwatch fresh while the fight runs.
    egg.getCombat?.().getLastAttack?.().reset?.();
  }
}

/** Everything still standing crumbles when the boss dies: eggs (11508) and minions go. */
function crumbleAll(bossNpc) {
  const session = sessionOf(bossNpc);
  if (!session) return;
  for (const entry of session.eggs) {
    if (!alive(entry.npc)) continue;
    entry.npc.performAnimation(new core.Animation(EGG_DEATH_ANIMATION));
    core.World.getRemoveNPCQueue().push(entry.npc);
  }
  for (const minion of session.minions) {
    if (alive(minion)) core.World.getRemoveNPCQueue().push(minion);
  }
  session.minions.length = 0;
}

/**
 * Edge-to-edge distance between the minion's footprint and its target: the engine stops a
 * pursuer at this distance, so the Ruptura's burst must measure it the same way or never
 * fires (base-to-base distance stays larger than its 2-tile reach).
 */
function edgeDistance(npc, target) {
  const base = npc.getLocation();
  const size = Math.max(1, npc.getSize?.() ?? 1);
  const pos = target.getLocation();
  const maxX = base.getX() + size - 1;
  const maxY = base.getY() + size - 1;
  const dx = pos.getX() < base.getX() ? base.getX() - pos.getX()
    : pos.getX() > maxX ? pos.getX() - maxX : 0;
  const dy = pos.getY() < base.getY() ? base.getY() - pos.getY()
    : pos.getY() > maxY ? pos.getY() - maxY : 0;
  return Math.max(dx, dy);
}

/** The Ruptura's burst: 11510, then 2 ticks later the 8x8 blast lands (Wiki) on the
 * boss, nearby players, minions and idle eggs — the egg-lure tactic works because
 * a burst catches the next egg too. */
function explodeRuptura(npc, target) {
  if (npc.getAttribute?.(RUPTURA_BURST_ATTRIBUTE) === true) return;
  npc.setAttribute?.(RUPTURA_BURST_ATTRIBUTE, true);
  npc.getMovementQueue?.().setBlockMovement?.(true);
  npc.performAnimation(new core.Animation(RUPTURA_ANIMATION));
  later(2, npc, () => {
    const session = sessionOf(npc);
    const boss = session?.npc ?? null;
    // A corpse keeps 1 HP so players can walk to it: never burst one.
    if (alive(boss) && boss.getAttribute?.(Shared.ATTR_DYING) !== true) {
      // Footprint-aware: 80 needs the blast overlapping his 7x7, 64 next to it.
      const feet = boss.getLocation();
      const from = npc.getLocation();
      const distance = Shared.edgeDistance(feet.getX(), feet.getY(), from.getX(), from.getY());
      if (distance < Shared.RUPTURA_BOSS_DAMAGE.length) {
        boss.getCombat().getHitQueue().addPendingDamage([
          new core.HitDamage(Shared.RUPTURA_BOSS_DAMAGE[distance], core.HitMask.BLUE),
        ]);
      }
    }
    for (const player of npc.getPlayersWithinDistance?.(5) ?? []) {
      if (!alive(player)) continue;
      const distance = edgeDistance(npc, player);
      if (distance < Shared.RUPTURA_PLAYER_DAMAGE.length) {
        player.getCombat().getHitQueue().addPendingDamage([
          new core.HitDamage(Shared.RUPTURA_PLAYER_DAMAGE[distance], core.HitMask.RED),
        ]);
      }
    }
    for (const minion of session?.minions ?? []) {
      if (minion === npc || !alive(minion)) continue;
      const distance = edgeDistance(npc, minion);
      if (distance < Shared.RUPTURA_BOSS_DAMAGE.length) {
        minion.getCombat().getHitQueue().addPendingDamage([
          new core.HitDamage(Shared.RUPTURA_BOSS_DAMAGE[distance], core.HitMask.BLUE),
        ]);
      }
    }
    for (const entry of session?.eggs ?? []) {
      const egg = entry?.npc ?? null;
      if (!alive(egg)) continue;
      const distance = edgeDistance(npc, egg);
      if (distance < Shared.RUPTURA_BOSS_DAMAGE.length) {
        egg.getCombat().getHitQueue().addPendingDamage([
          new core.HitDamage(Shared.RUPTURA_BOSS_DAMAGE[distance], core.HitMask.BLUE),
        ]);
      }
    }
    core.World.getRemoveNPCQueue().push(npc);
  });
}

/** Wielded weapon name, "" when unarmed. */
function weaponName(player) {
  const weapon = player?.getEquipment?.().getWeapon?.();
  return weapon && weapon.getId?.() >= 0 ? weapon.getDefinition?.()?.getName?.() ?? "" : "";
}

/** Wiki's bypass list for the Mirrorback's deflection: halberd, crossbow, ballista. */
function instantKillWeapon(player) {
  const lowered = weaponName(player).toLowerCase();
  return INSTANT_KILL_WEAPONS.some((entry) => lowered.includes(entry));
}

/** Wiki: crush weapons max-hit when crush is the attacker's top melee accuracy. */
function crushStyle(player) {
  if (!BonusManager) return false;
  const atk = player?.getBonusManager?.().getAttackBonus?.() ?? [];
  const crush = atk[BonusManager.ATTACK_CRUSH] ?? 0;
  return player?.getFightType?.()?.getBonusType?.() === BonusManager.ATTACK_CRUSH
    && crush > 0
    && crush >= (atk[BonusManager.ATTACK_STAB] ?? 0)
    && crush >= (atk[BonusManager.ATTACK_SLASH] ?? 0);
}

/** Wiki max hit against a hatched araxyte for this hit, or null to roll normally:
 * heavy ranged rolls ranged max, halberd/crush-style rolls melee max. Magic and
 * unlisted setups get no guarantee. */
function maxHitVsAraxyte(player, hit) {
  const type = hit.getCombatType?.();
  if (type === core.CombatType.MAGIC) return null;
  const lowered = weaponName(player).toLowerCase();
  if (type === core.CombatType.RANGED) {
    if (!lowered.includes("crossbow") && !lowered.includes("ballista")) return null;
    return core.DamageFormulas.calculateMaxRangedHit(player);
  }
  if (!lowered.includes("noxious halberd") && !crushStyle(player)) return null;
  return core.DamageFormulas.calculateMaxMeleeHit(player);
}

/** Max-hit setups, then the Mirrorback's reflection: half back at melee attackers. */
function modifyHit(event) {
  const { npc, hit } = event;
  const id = npc?.getId?.();
  if (!id) return;
  const isEgg = id === Shared.EGG_ID.mirrorback || id === Shared.EGG_ID.ruptura || id === Shared.EGG_ID.acidic;
  const isMinion = id === Shared.MINION_ID.mirrorback || id === Shared.MINION_ID.ruptura || id === Shared.MINION_ID.acidic;
  if (!isEgg && !isMinion) return;
  const attacker = hit.getAttacker?.();
  const hits = hit.getHits?.() ?? [];
  if (hits.length === 0) return;
  if (isMinion && attacker?.isPlayer?.()) {
    const max = maxHitVsAraxyte(attacker.getAsPlayer(), hit);
    if (max != null && max > 0) {
      for (let index = 0; index < hits.length; index++) {
        hits[index].setDamage(index === 0 ? max : 0);
      }
      hit.updateTotalDamage?.();
    }
  }
  if (id !== Shared.MINION_ID.mirrorback || !attacker?.isPlayer?.()) return;
  const player = attacker.getAsPlayer();
  if (instantKillWeapon(player)) return;
  const type = hit.getCombatType?.();
  if (type === core.CombatType.MAGIC || type === core.CombatType.RANGED) return;
  const damage = hits.reduce((total, part) => total + (part.getDamage?.() ?? 0), 0);
  if (damage <= 1) return;
  player.getCombat().getHitQueue().addPendingDamage([
    new core.HitDamage(Math.floor(damage / 2), core.HitMask.RED),
  ]);
}

/** The eggs themselves are inert: no attacks, no retaliation, no pursuit. */
function eggClass() {
  const { CombatMethod, CombatType } = core;
  return class AraxyteEggCombat extends CombatMethod {
    canAttack() {
      return false;
    }

    start() {}

    hits() {
      return [];
    }

    attackDistance() {
      return 1;
    }

    attackSpeed() {
      return 1;
    }

    type() {
      return CombatType.MELEE;
    }
  };
}

function minionClass() {
  const { CombatMethod, CombatType } = core;
  return class AraxyteCombat extends CombatMethod {
    start(character, target) {
      const npc = character?.getAsNpc?.();
      this.npc = npc ?? null;
      if (!npc || !target) return;
      const id = npc.getId();
      if (id === Shared.MINION_ID.ruptura) {
        if (edgeDistance(npc, target) <= 2) {
          this.attack = "burst";
          explodeRuptura(npc, target);
        }
        return;
      }
      if (id === Shared.MINION_ID.acidic) {
        this.attack = "ranged";
        npc.performAnimation(new core.Animation(11498));
        const from = npc.getLocation();
        const to = target.getLocation();
        const flight = 30 + 20 * Math.max(1, from.getDistance(to));
        new core.Projectile(
          from, to, target, Shared.MINION_PROJECTILE, 30, flight, 30, 0, npc.getPrivateArea(),
        ).sendProjectile();
        this.shotDelay = Math.ceil(flight / 30);
        return;
      }
      this.attack = "melee";
      npc.performAnimation(new core.Animation(11500));
    }

    hits(character, target) {
      if (!character || !target || !this.attack || this.attack === "burst") return [];
      const ranged = this.attack === "ranged";
      const hit = new core.PendingHit(character, target, this, ranged ? { delay: this.shotDelay ?? 1 } : 0);
      hit.setTotalDamage(Math.min(Shared.MINION_MAX, hit.getTotalDamage()));
      return [hit];
    }

    attackDistance() {
      return this.npc?.getId?.() === Shared.MINION_ID.acidic ? 7 : 2;
    }

    attackSpeed() {
      return this.npc?.getId?.() === Shared.MINION_ID.ruptura ? 2 : 6;
    }

    type() {
      return this.attack === "ranged" ? CombatType.RANGED : CombatType.MELEE;
    }
  };
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  BonusManager = pluginApi.getBonusManager();
  pluginApi.onNpcHitModify(modifyHit);
  pluginApi.registerNpcCombatMethodProvider(
    [core.NpcIdentifiers.EGG_10, core.NpcIdentifiers.EGG_11, core.NpcIdentifiers.EGG_12],
    eggClass(),
    { singleton: true },
  );
  pluginApi.registerNpcCombatMethodProvider(
    [core.NpcIdentifiers.MIRRORBACK_ARAXYTE, core.NpcIdentifiers.RUPTURA_ARAXYTE, core.NpcIdentifiers.ACIDIC_ARAXYTE],
    minionClass(),
    { singleton: false },
  );
}

module.exports = {
  attach,
  spawnEggs,
  hatchNext,
  ensureTargets,
  pinEggs,
  crumbleAll,
  explodeRuptura,
  modifyHit,
  instantKillWeapon,
  crushStyle,
  minionClass,
  eggClass,
  edgeDistance,
  _test: { instantKillWeapon, crushStyle, edgeDistance },
};
