/**
 * The Ranged masteries (https://oldschool.runescape.wiki/w/Ranged_I .. Ranged_VI): I a landed
 * roll below 30% of the max hit becomes 30% (on the core's `combat:hit-rolled`, before defences); II every ranged attack after the first raises the max
 * hit another 5%, back to nothing after +20% (counted on the attack's first accuracy roll, so the
 * max hit rolled next sees it); IV every fifth landed ranged hit heals 5 hitpoints a hitsplat; VI a ranged
 * attack on an NPC never misses. The attack rates (III, V) are AttackRate.LeagueCombatMasteries.js.
 */
const Common = require("./Common.LeagueCombatMasteries");

let core;

/** Ranged II: attacks made since the bonus last reset (0-4), the bonus steps of the attack under way, and its cycle. */
const streak = new WeakMap();
const steps = new WeakMap();
const lastAttack = new WeakMap();
/** Ranged IV: landed ranged hits since the last heal. */
const landed = new WeakMap();

const RANGED = () => core.CombatType.RANGED;

/**
 * Ranged II counts an attack on its first accuracy roll of a cycle (a special rolls its hits
 * before the attack-speed hook, a normal attack after it; a mobile attacks once a cycle), so the
 * max hit that follows the roll sees this attack's step.
 */
function countAttack(attacker) {
  const second = Common.effect(attacker, "ranged", 2);
  if (!second) {
    streak.delete(attacker);
    steps.delete(attacker);
    lastAttack.delete(attacker);
    return;
  }
  const cycle = core.World.getProcessCycle();
  if (lastAttack.get(attacker) === cycle) return;
  lastAttack.set(attacker, cycle);
  const limit = Math.round(second.maxHitCap / second.maxHitStep);
  const current = streak.get(attacker) ?? 0;
  steps.set(attacker, current);
  streak.set(attacker, current >= limit ? 0 : current + 1);
}

/** The max hit with Ranged II's steps on it, as the roll saw it. */
function boostedMaxHit(attacker, maxHit) {
  const second = Common.effect(attacker, "ranged", 2);
  if (!second) return maxHit;
  const percent = Math.round(second.maxHitStep * 100) * (steps.get(attacker) ?? 0);
  return Math.floor((maxHit * (100 + percent)) / 100);
}

const maxHitModifier = {
  modifyMaxHit(attacker, _target, maxHit) {
    return Common.effect(attacker, "ranged", 2) ? boostedMaxHit(attacker, maxHit) : null;
  },
  modifyAttackRoll() {
    return null;
  },
};

/** Ranged I: a landed roll below 30% of its max hit (Ranged II's bonus on it) is raised to it, before the target's defences. */
function rolled(event) {
  if (event.combatType !== RANGED()) return;
  const first = Common.effect(event.attacker, "ranged", 1);
  if (!first) return;
  const floor = Math.floor(event.maximum * first.minimumFraction);
  if (event.damage < floor) event.damage = floor;
}

function resolved({ attacker, hit }) {
  if (hit.getCombatType() !== RANGED() || !hit.isAccurate()) return;
  const fourth = Common.effect(attacker, "ranged", 4);
  if (!fourth) {
    landed.delete(attacker);
    return;
  }
  const count = (landed.get(attacker) ?? 0) + 1;
  if (count < fourth.everyHits) {
    landed.set(attacker, count);
    return;
  }
  landed.set(attacker, 0);
  attacker.heal(fourth.heal * Math.max(1, hit.getHits?.()?.length ?? 1));
}

/** A ranged roll: Ranged II's count, and Ranged VI's certain hit on an NPC. */
function roll(event) {
  if (event.combatType !== RANGED() || !Common.isEchoes(event.attacker)) return;
  countAttack(event.attacker);
  if (event.target?.isNpc?.() && Common.effect(event.attacker, "ranged", 6)?.neverMiss) event.forceAccurate = true;
}

module.exports = function attach(api) {
  core = api.core;
  api.registerRangedCombatModifier(maxHitModifier);
  api.onCustomEvent("combat:hit-rolled", rolled);
  api.onCombatHitResolved(resolved);
  api.onCombatHitRoll(roll);
};
