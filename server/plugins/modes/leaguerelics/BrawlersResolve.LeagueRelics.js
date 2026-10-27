/**
 * Brawler's Resolve (https://oldschool.runescape.wiki/w/Brawler's_Resolve), Trailblazer Reloaded's
 * tier 4 melee relic: melee weapons attack at half their speed (above 4 rounded down, below 3
 * rounded up), melee accuracy +50%, every defence +50%, a landed melee hit has a 10% chance to deal
 * double damage, 90% of a melee weapon's charges are saved, and the player is immune to poison,
 * venom and dragonfire (the Wiki's status effects; it keeps stuns and roots).
 */
const Common = require("./Common.LeagueRelics");
const { halved } = require("./ArchersEmbrace.LeagueRelics");

let core;
let effect;
let immune;

function active(player) {
  return Common.effectActive(player, effect);
}

function meleeAttack(player) {
  return core.CombatFactory.getMethod(player).type() === core.CombatType.MELEE;
}

function attackSpeed(event) {
  if (event.combatType === core.CombatType.MELEE && active(event.attacker)) event.speed = halved(event.speed);
}

function meleeAccuracy(entity, roll) {
  return active(entity) ? roll * effect.accuracyMultiplier : roll;
}

/** The melee defence level also feeds the ranged roll, so this and the magic one cover all three. */
function defence(entity, level) {
  return active(entity) ? level * effect.defenceMultiplier : level;
}

function doubleDamage(event) {
  if (Common.isBuildingDerivedHit() || event.combatType !== core.CombatType.MELEE || !event.accurate || !active(event.attacker)) return;
  if (Math.random() < effect.doubleDamageChance) event.damage.setDamage(event.damage.getDamage() * 2);
}

/** `combat:consume-charge`: a melee weapon's charge (scythe, crystal halberd, Arclight) is kept 90% of the time. */
function consumeCharge(request) {
  if (request.skip || !active(request.player) || !meleeAttack(request.player)) return;
  if (Math.random() < effect.chargeSaveChance) request.skip = true;
}

function immuneSet() {
  if (!immune) immune = new Set(effect.immuneStatuses);
  return immune;
}

/** `combat:status-apply`: poison, venom and dragonfire never take. */
function statusApply(request) {
  if (immuneSet().has(request.kind) && active(request.target)) request.allow = false;
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.brawlersResolve;
  api.onAttackSpeed(attackSpeed);
  api.registerMeleeAttackAccuracyModifier(meleeAccuracy);
  api.registerMeleeDefenseModifier(defence);
  api.registerMagicDefenseModifier(defence);
  api.onCombatHitDamage(doubleDamage);
  api.onCustomEvent("combat:consume-charge", consumeCharge);
  api.onCustomEvent("combat:status-apply", statusApply);
};
