/**
 * Archer's Embrace (https://oldschool.runescape.wiki/w/Archer's_Embrace), Trailblazer Reloaded's
 * tier 4 ranged relic: ranged weapons attack at half their speed (above 4 rounded down, below 3
 * rounded up, so 3, 4 and 5 all become 2), ranged accuracy is doubled, a landed hit has a 10% chance
 * to fire an extra projectile with a roll of its own, 90% of ammunition and of a ranged weapon's
 * charges are saved (an Ava's device then recovers its share of the rest, the Wiki's 98%), and
 * enchanted bolts proc twice as often.
 */
const Common = require("./Common.LeagueRelics");

let api;
let core;
let effect;

/** The extra projectiles this relic fired, so they never fire another. */
const extraHits = new WeakSet();

function active(player) {
  return Common.effectActive(player, effect);
}

/** The Wiki's halving: speeds above 4 round down, below 3 round up (3 and 4 become 2). */
function halved(speed) {
  return Math.max(1, speed > 4 ? Math.floor(speed / 2) : Math.ceil(speed / 2));
}

function rangedAttack(player) {
  return core.CombatFactory.getMethod(player).type() === core.CombatType.RANGED;
}

function attackSpeed(event) {
  if (event.combatType === core.CombatType.RANGED && active(event.attacker)) event.speed = halved(event.speed);
}

function rangedAccuracy(entity, roll) {
  return active(entity) ? roll * effect.accuracyMultiplier : roll;
}

/**
 * A landed ranged hit has a 10% chance of an extra projectile, rolled on its own and queued as any
 * hit (XP, hooks); no ammunition spent for it (ours). It is an ordinary shot: a special armed after
 * the original shot left stays armed for the next attack, not borrowed for nothing.
 */
function extraProjectile({ attacker, target, hit }) {
  if (extraHits.has(hit) || hit.getCombatType() !== core.CombatType.RANGED || !hit.isAccurate() || !active(attacker)) return;
  if (Math.random() >= effect.extraProjectileChance) return;
  const extra = new core.PendingHit(attacker, target, hit.getCombatMethod(), { delay: 0, ordinary: true });
  extraHits.add(extra);
  core.CombatFactory.addPendingHit(extra);
}

/** `ranged:ammo-saving`: each shot of the volley is kept with the relic's chance. */
function ammoSaving(request) {
  if (!active(request.player)) return;
  for (let shot = request.saved; shot < request.amount; shot++) {
    if (Math.random() < effect.ammoSaveChance) request.saved++;
  }
}

/** `combat:consume-charge`: a ranged weapon's charge (crystal bow, venator bow) is kept with the same chance. */
function consumeCharge(request) {
  if (request.skip || !active(request.player) || !rangedAttack(request.player)) return;
  if (Math.random() < effect.ammoSaveChance) request.skip = true;
}

function boltProcChance(request) {
  if (active(request.player)) request.chance *= effect.boltProcMultiplier;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.archersEmbrace;
  api.onAttackSpeed(attackSpeed);
  api.registerRangedAttackAccuracyModifier(rangedAccuracy);
  api.onCombatHitResolved(extraProjectile);
  api.onCustomEvent("ranged:ammo-saving", ammoSaving);
  api.onCustomEvent("combat:consume-charge", consumeCharge);
  api.onCustomEvent("combat:bolt-proc-chance", boltProcChance);
};

module.exports.halved = halved;
