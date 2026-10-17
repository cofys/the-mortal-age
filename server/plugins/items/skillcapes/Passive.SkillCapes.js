/**
 * Skillcape perks that hook another plugin's or the core's event (Wiki: Cape of Accomplishment):
 *
 * - Mining: a worn Mining cape gives a 5% chance of an extra ore from rocks up to adamantite
 *   ("mining:extra-ore").
 * - Hitpoints: a worn Hitpoints cape doubles natural Hitpoints regeneration; it does not stack
 *   with Rapid Heal ("stats:restore-rate").
 *
 * The rest are asked for by their own plugins through "skillcape:has-perk".
 */
const Capes = require("./Common.SkillCapes");

const EXTRA_ORE_CHANCE = 0.05;
const EXTRA_ORE_MAX_LEVEL = 70;
const DOUBLE_REGEN = 2;

function extraOre(request) {
  if (request.extra || request.rockLevel > EXTRA_ORE_MAX_LEVEL || !Capes.hasPerk(request.player, "MINING")) return;
  if (Math.random() < EXTRA_ORE_CHANCE) request.extra = true;
}

function hitpointsRegen(restore) {
  if (restore.skill !== Capes.core.Skill.HITPOINTS || !Capes.hasPerk(restore.player, "HITPOINTS")) return;
  restore.rate = Math.max(restore.rate, DOUBLE_REGEN);
}

module.exports = function attachPassive(api) {
  api.onCustomEvent("mining:extra-ore", extraOre);
  api.onCustomEvent("stats:restore-rate", hitpointsRegen);
};

module.exports._test = { extraOre, hitpointsRegen };
