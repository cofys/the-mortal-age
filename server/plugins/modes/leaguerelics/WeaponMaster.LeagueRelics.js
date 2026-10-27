/**
 * Weapon Master (https://oldschool.runescape.wiki/w/Weapon_Master), Trailblazer Reloaded's tier 7
 * relic: special attacks always land on NPCs and deal at least 20% of the max hit (on any target),
 * special energy restores 30% a cycle (the cycle is the usual 30 seconds, 15 with a lightbearer),
 * and a player short of energy may use a special anyway for 25 hitpoints instead of the energy
 * (only with more than 25 left: ours).
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function specialAgainstNpc(attacker, target) {
  return target?.isNpc?.() === true && attacker.isSpecialActivated() && active(attacker);
}

function landsOnNpcs(roll) {
  if (specialAgainstNpc(roll.attacker, roll.target)) roll.forceAccurate = true;
}

function minimumHit({ attacker, target, combatType, damage, accurate }) {
  if (Common.isBuildingDerivedHit() || !accurate || !attacker.isSpecialActivated() || !active(attacker)) return;
  const minimum = Math.floor(Common.maxHitFor(attacker, target, combatType) * effect.minimumHitFraction);
  if (damage.getDamage() < minimum) damage.setDamage(minimum);
}

function regenerate(request) {
  if (active(request.player)) request.amount = effect.regenPercent;
}

/**
 * `combat-special:cost`: a player short of energy may still use the special; the drain then costs
 * 25 hitpoints instead of energy (the Wiki's "instead": none is taken).
 */
function cost(request) {
  const { player } = request;
  if (request.available >= request.cost || !active(player)) return;
  if (request.phase === "check") {
    if (player.getHitpoints() > effect.sacrificeHitpoints) request.allow = true;
    return;
  }
  const hitpoints = player.getHitpoints();
  if (hitpoints <= 1) return;
  request.cost = 0;
  player.setHitpoints(hitpoints - Math.min(effect.sacrificeHitpoints, hitpoints - 1));
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.weaponMaster;
  api.onCombatHitRoll(landsOnNpcs);
  api.onCombatHitDamage(minimumHit);
  api.onCustomEvent("combat-special:regenerate", regenerate);
  api.onCustomEvent("combat-special:cost", cost);
};
