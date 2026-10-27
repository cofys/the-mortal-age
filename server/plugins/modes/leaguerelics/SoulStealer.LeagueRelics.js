/**
 * Soul Stealer (https://oldschool.runescape.wiki/w/Soul_Stealer), Trailblazer Reloaded's tier 7
 * relic: the minimum hit rises to 10% of the max hit, and a landed hit has a 50% chance to restore
 * hitpoints and prayer by 10% of its damage, rounded up. The restore skips special attacks and
 * attacks that strike several targets at once (a scythe whose three hits land on one target
 * counts; an enchanted bolt's effect is part of its hit, so it counts too).
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

/** Each hit's launch: the attacker's special state and every target struck in that cycle. */
const launches = new WeakMap();
const current = new WeakMap();

function active(player) {
  return Common.effectActive(player, effect);
}

/** Records the launch and raises the hit to the relic's minimum. */
function onDamage({ attacker, target, combatType, hit, damage, accurate }) {
  // A hit derived from another (Superior Sorcerer's splash) carries its parent's damage already; it is not raised again.
  if (Common.isBuildingDerivedHit() || !active(attacker)) return;
  const cycle = core.World.getProcessCycle();
  let launch = current.get(attacker);
  if (!launch || launch.cycle !== cycle) {
    launch = { cycle, special: attacker.isSpecialActivated(), targets: new Set() };
    current.set(attacker, launch);
  }
  launch.targets.add(target);
  launches.set(hit, launch);
  if (!accurate) return;
  const minimum = Math.floor(Common.maxHitFor(attacker, target, combatType) * effect.minimumHitFraction);
  if (damage.getDamage() < minimum) damage.setDamage(minimum);
}

function restore(player, amount) {
  const { Skill } = core;
  const skills = player.getSkillManager();
  player.heal(amount);
  const prayer = Math.min(skills.getMaxLevel(Skill.PRAYER), skills.getCurrentLevel(Skill.PRAYER) + amount);
  skills.setCurrentLevel(Skill.PRAYER, prayer, true);
}

/** A landed single-target, non-special hit has a 50% chance to restore a tenth of its damage. */
function onResolved({ attacker, hit }) {
  if (!hit.isAccurate() || hit.getTotalDamage() <= 0 || !active(attacker)) return;
  const launch = launches.get(hit);
  if (!launch || launch.special || launch.targets.size > 1) return;
  if (Math.random() >= effect.restoreChance) return;
  restore(attacker, Math.ceil(hit.getTotalDamage() * effect.restoreFraction));
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.soulStealer;
  api.onCombatHitDamage(onDamage);
  api.onCombatHitResolved(onResolved);
};
