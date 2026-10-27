/**
 * Berserker (https://oldschool.runescape.wiki/w/Berserker_(Trailblazer_Reloaded_League)),
 * Trailblazer Reloaded's tier 7 relic: damage dealt rises 0.4% for every hitpoint missing, and a
 * hit on an NPC at full health is a guaranteed max hit.
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function scaleByMissingHitpoints(event) {
  // A hit derived from another (Superior Sorcerer's splash) is a share of a hit this already scaled.
  if (Common.isBuildingDerivedHit() || !active(event.attacker)) return;
  const skills = event.attacker.getSkillManager();
  const missing = Math.max(0, skills.getMaxLevel(core.Skill.HITPOINTS) - event.attacker.getHitpoints());
  if (missing === 0) return;
  event.damage.setDamage(Math.floor(event.damage.getDamage() * (1 + effect.damagePerMissingHitpoint * missing)));
}

function maxHitOnFullNpc(roll) {
  if (!roll.target?.isNpc?.() || !active(roll.attacker)) return;
  if (roll.target.getHitpoints() < roll.target.getMaxHitpoints()) return;
  roll.forceAccurate = true;
  roll.forceMaxHit = true;
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.berserker;
  api.onCombatHitDamage(scaleByMissingHitpoints);
  api.onCombatHitRoll(maxHitOnFullNpc);
};
