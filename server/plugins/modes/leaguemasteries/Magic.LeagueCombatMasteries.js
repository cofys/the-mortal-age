/**
 * The Magic masteries (https://oldschool.runescape.wiki/w/Magic_I .. Magic_VI): I a landed roll
 * above 90% of the max hit deals 50% more; II the max hit rises 5% for every idle tick between two
 * magic attacks, up to +40% (our reading of "per tick in-between": the gap less the attack's own
 * tick, and the cap for the first cast since login); IV a roll above 90% heals 10% of the damage when the hit lands; VI the max hit rises 1%
 * for every 100 hitpoints the target has, up to +10%, and a target with fewer hitpoints than the
 * max hit (before Magic I, Wiki) takes the max hit. The max hit changes ride the core's
 * `combat:magic-max-hit` request, so every magic max hit (and Magic I's threshold) includes them;
 * Magic I and IV judge the roll on `combat:hit-rolled`, before the target's defences.
 * The attack rates (III, V) are AttackRate.LeagueCombatMasteries.js.
 */
const Common = require("./Common.LeagueCombatMasteries");

let core;

/** Magic II: the cycle of each player's last magic attack, and the bonus (in percent) of the attack under way. */
const lastCast = new WeakMap();
const bonus = new WeakMap();
/** Hits whose roll was above 90% of the max hit (Magic IV heals when they land). */
const highRolls = new WeakSet();
/** The attacker and target of the roll just made above 90%, until its hit takes the mark. */
let highRoll = null;

const MAGIC = () => core.CombatType.MAGIC;

/**
 * Magic II notes a cast on its first accuracy roll of a cycle (before the max hit is asked; a
 * special rolls before the attack-speed hook, a normal cast after it). With no cast known since
 * login the idle ticks are taken as the cap.
 */
function noteCast(attacker) {
  const second = Common.effect(attacker, "magic", 2);
  if (!second) {
    bonus.delete(attacker);
    lastCast.delete(attacker);
    return;
  }
  const cycle = core.World.getProcessCycle();
  const previous = lastCast.get(attacker);
  if (previous === cycle) return;
  const cap = Math.round(second.cap * 100);
  const idle = previous === undefined ? Infinity : Math.max(0, cycle - previous - 1);
  bonus.set(attacker, Math.min(cap, idle * Math.round(second.perTick * 100)));
  lastCast.set(attacker, cycle);
}

function maxHit(request) {
  const { attacker, target } = request ?? {};
  if (!attacker?.isPlayer?.() || !Common.isEchoes(attacker)) return;
  let percent = 0;
  if (Common.effect(attacker, "magic", 2)) percent += bonus.get(attacker) ?? 0;
  const sixth = Common.effect(attacker, "magic", 6);
  if (sixth && typeof target?.getHitpoints === "function") {
    const stepPercent = Math.round(sixth.perStep * 100);
    percent += Math.min(Math.round(sixth.cap * 100), Math.floor(target.getHitpoints() / sixth.perHitpoints) * stepPercent);
  }
  if (percent > 0) request.maxHit = Math.floor((request.maxHit * (100 + percent)) / 100);
}

/**
 * Magic I, and Magic IV's mark: a roll above 90% of its own max hit (this target's: a barrage's
 * secondary has its own), judged on the core's `combat:hit-rolled` before the target's
 * protection prayer or damage reductions, which then apply to the raised damage.
 */
function rolled(event) {
  highRoll = null;
  if (event.combatType !== MAGIC()) return;
  const first = Common.effect(event.attacker, "magic", 1);
  const fourth = Common.effect(event.attacker, "magic", 4);
  if (!first && !fourth) return;
  if (event.damage <= Math.floor(event.maximum * (first ?? fourth).highRollFraction)) return;
  if (first) event.damage = Math.floor(event.damage * first.damageMultiplier);
  if (fourth) highRoll = { attacker: event.attacker, target: event.target };
}

/** The rolled hitsplat reaches its PendingHit: a high roll's hit is marked for Magic IV. */
function damage(event) {
  const mark = highRoll;
  highRoll = null;
  if (mark && event.accurate && event.hit && mark.attacker === event.attacker && mark.target === event.target) highRolls.add(event.hit);
}

function resolved({ attacker, hit }) {
  if (!highRolls.has(hit)) return;
  highRolls.delete(hit);
  const fourth = Common.effect(attacker, "magic", 4);
  if (fourth && hit.isAccurate()) attacker.heal(Math.floor(hit.getTotalDamage() * fourth.healFraction));
}

/** A magic roll: Magic II's cast, then Magic VI's execute (a target with fewer hitpoints than the max hit takes it, on an accurate roll). */
function roll(event) {
  if (event.combatType !== MAGIC() || !Common.isEchoes(event.attacker)) return;
  noteCast(event.attacker);
  if (!Common.effect(event.attacker, "magic", 6)?.execute) return;
  if (event.target.getHitpoints() < Common.maxHit(event.attacker, MAGIC(), event.target)) event.forceMaxHit = true;
}

module.exports = function attach(api) {
  core = api.core;
  api.onCustomEvent("combat:magic-max-hit", maxHit);
  api.onCustomEvent("combat:hit-rolled", rolled);
  api.onCombatHitDamage(damage);
  api.onCombatHitResolved(resolved);
  api.onCombatHitRoll(roll);
};
