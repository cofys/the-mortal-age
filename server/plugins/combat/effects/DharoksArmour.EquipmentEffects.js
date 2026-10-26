let core;
let CombatFactory;

/**
 * Wretched Strength (https://oldschool.runescape.wiki/w/Dharok%27s_armour): the damage modifier
 * 1 + (Max HP - Current HP) / 100 x Max HP / 100 "is applied to a player's hit after the damage
 * roll", so it scales the rolled hit rather than the max hit.
 */
function applyDharokModifiers({ attacker, combatType, damage }) {
  if (combatType !== core.CombatType.MELEE || !attacker || !CombatFactory.fullDharoks(attacker)) return;
  const maximum = attacker.isPlayer()
    ? attacker.getAsPlayer().getSkillManager().getMaxLevel(core.Skill.HITPOINTS)
    : attacker.getAsNpc().getDefinition().getHitpoints();
  const missing = Math.max(0, maximum - attacker.getHitpoints());
  damage.multiplyDamage(1 + missing * maximum / 10000);
}

module.exports = function registerDharoksArmourEffects(api) {
  core = api.core;
  CombatFactory = api.getCombatFactory();
  api.onCombatHitDamage(applyDharokModifiers);
};
