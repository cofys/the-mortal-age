/**
 * Colossal blade (https://oldschool.runescape.wiki/w/Colossal_blade): "MaxHit + [2 ×
 * min(MonsterSize,5)]", the monster's size being the squares along one side. The Wiki DPS
 * calculator adds it after the salve amulet, black mask, Dragon hunter and demonbane factors,
 * so it registers after them.
 */
const { asPlayer, weaponName, targetNpc } = require("./GearChecks.EquipmentEffects");

const BLADE = "colossal blade";
const MAX_SIZE = 5;

function meleeDamage(entity, value) {
  const npc = targetNpc(entity);
  if (npc == null || weaponName(asPlayer(entity)) !== BLADE) return value;
  return value + 2 * Math.min(npc.getSize(), MAX_SIZE);
}

module.exports = function registerColossalBladeEffects(api) {
  api.registerMeleeHitModifier(meleeDamage);
};

module.exports._test = { meleeDamage };
