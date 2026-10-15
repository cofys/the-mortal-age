/**
 * Vampyrebane weapons against NPCs tagged with the Wiki's `vampyre` attribute.
 * Source: OSRS Wiki, Vampyre (attribute), and the linked weapon pages.
 */
const { asPlayer, weaponName, targetHasAttribute, scale } = require("./GearChecks.EquipmentEffects");

const MELEE = new Map([
  ["ivandis flail", { damage: 20, accuracy: 0 }],
  ["blisterwood sickle", { damage: 15, accuracy: 5 }],
  ["blisterwood sickle (e)", { damage: 15, accuracy: 5 }],
  ["blisterwood flail", { damage: 25, accuracy: 5 }],
  ["hallowed flail", { damage: 25, accuracy: 25 }],
  ["sunspear", { damage: 50, accuracy: 25 }],
]);
const RANGED = new Map([["blisterwood stake", { damage: 25, accuracy: 25 }]]);

function bonusFor(entity, table) {
  const player = asPlayer(entity);
  if (!player || !targetHasAttribute(entity, "vampyre")) return null;
  return table.get(weaponName(player)) ?? null;
}

function damage(entity, value, table) {
  const bonus = bonusFor(entity, table);
  return bonus ? scale(value, 100 + bonus.damage, 100) : value;
}

function accuracy(entity, value, table) {
  const bonus = bonusFor(entity, table);
  return bonus ? scale(value, 100 + bonus.accuracy, 100) : value;
}

function meleeDamage(entity, value) { return damage(entity, value, MELEE); }
function meleeAccuracy(entity, value) { return accuracy(entity, value, MELEE); }
function rangedDamage(entity, value) { return damage(entity, value, RANGED); }
function rangedAccuracy(entity, value) { return accuracy(entity, value, RANGED); }

module.exports = function registerVampyrebaneEffects(api) {
  api.registerMeleeHitModifier(meleeDamage);
  api.registerMeleeAttackAccuracyModifier(meleeAccuracy);
  api.registerRangedHitModifier(rangedDamage);
  api.registerRangedAttackAccuracyModifier(rangedAccuracy);
};

module.exports._test = { meleeDamage, meleeAccuracy, rangedDamage, rangedAccuracy };
