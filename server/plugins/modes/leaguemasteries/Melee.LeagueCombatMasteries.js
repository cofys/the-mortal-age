/**
 * The Melee masteries (https://oldschool.runescape.wiki/w/Melee_I .. Melee_VI): I a 25% chance to
 * roll the damage twice and keep the higher; II a 10% chance that a melee attack on an NPC is
 * followed by an echo hit, an ordinary melee hit of its own accuracy rolled from half the max hit,
 * a tick later, queued as any hit (its guards and XP; the Wiki does not say whether an echo pays
 * XP), with the captured echo projectile; IV a 5% chance that a landed hit heals 40% of its
 * damage; VI echoes on 20% of attacks and lets an echo echo in turn, up to eight in a row. The
 * rolls act on the core's `combat:hit-rolled`, before the target's defences reduce the hit. The
 * attack rates (III, V) are AttackRate.LeagueCombatMasteries.js.
 */
const Common = require("./Common.LeagueCombatMasteries");

let core;

/** Echo hits this unit queued, and how many echoes deep they are (1 for an echo of a real hit). */
const echoes = new WeakMap();
/** The attacker whose echo is being built (its PendingHit rolls inside the constructor). */
let building = null;
/** Which of the two echo projectiles each attacker sent last. */
const side = new WeakMap();

const MELEE = () => core.CombatType.MELEE;

/** An echo's own roll from half the max hit, then Melee I's second roll, both on the undefended roll. */
function rolled(event) {
  if (event.combatType !== MELEE() || !Common.isEchoes(event.attacker)) return;
  let { minimum, maximum } = event;
  if (building === event.attacker) {
    maximum = Math.floor(maximum * Common.mastery("melee", 2).effect.echoMaxHitFraction);
    minimum = Math.min(minimum, maximum);
    event.damage = core.Misc.randomInclusive(minimum, maximum);
  }
  const first = Common.effect(event.attacker, "melee", 1);
  if (!first || Math.random() >= first.rerollChance) return;
  const second = core.Misc.randomInclusive(minimum, maximum);
  if (second > event.damage) event.damage = second;
}

function echoChance(attacker, depth) {
  const second = Common.effect(attacker, "melee", 2);
  if (!second) return 0;
  const sixth = Common.effect(attacker, "melee", 6);
  if (depth > 0 && (!sixth || depth >= sixth.echoChainLimit)) return 0;
  return sixth?.echoChance ?? second.echoChance;
}

/**
 * Builds an echo as an ordinary melee attack: a special armed since the parent swing neither
 * shapes it (hit count, accuracy, max hit) nor is spent on it, and stays armed for the next attack.
 */
function ordinaryHit(attacker, build) {
  const armed = attacker.isSpecialActivated();
  building = attacker;
  if (armed) attacker.setSpecialActivated(false);
  try {
    return build();
  } finally {
    if (armed) attacker.setSpecialActivated(true);
    building = null;
  }
}

function queueEcho(attacker, target, depth) {
  const second = Common.mastery("melee", 2).effect;
  const echo = ordinaryHit(attacker, () => new core.PendingHit(attacker, target, core.CombatFactory.MELEE_COMBAT, { delay: second.echoDelay }));
  echoes.set(echo, depth + 1);
  core.CombatFactory.addPendingHit(echo);
  const turn = side.get(attacker) ?? 0;
  side.set(attacker, turn + 1);
  const projectile = second.echoProjectiles[turn % second.echoProjectiles.length];
  core.Projectile.createProjectile(attacker, target, projectile, second.echoProjectileDelay, second.echoProjectileSpeed,
    second.echoProjectileHeights[0], second.echoProjectileHeights[1]).sendProjectile();
}

/** A melee hit landed: Melee IV's heal, then the echo roll (II, VI). */
function resolved({ attacker, target, hit }) {
  if (hit.getCombatType() !== MELEE() || !Common.isEchoes(attacker)) return;
  const fourth = Common.effect(attacker, "melee", 4);
  const dealt = hit.isAccurate() ? hit.getTotalDamage() : 0;
  if (fourth && dealt > 0 && Math.random() < fourth.healChance) attacker.heal(Math.floor(dealt * fourth.healFraction));
  if (!target?.isNpc?.() || target.getHitpoints() <= 0) return;
  const depth = echoes.get(hit) ?? 0;
  const chance = echoChance(attacker, depth);
  if (chance > 0 && Math.random() < chance) queueEcho(attacker, target, depth);
}

module.exports = function attach(api) {
  core = api.core;
  api.onCustomEvent("combat:hit-rolled", rolled);
  api.onCombatHitResolved(resolved);
};

module.exports.isEcho = (hit) => echoes.has(hit);
