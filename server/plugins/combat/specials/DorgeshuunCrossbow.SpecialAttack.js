// Snipe (https://oldschool.runescape.wiki/w/Dorgeshuun_crossbow): never misses a target nobody,
// or another player, damaged last, and lowers the Defence of a player or NPC by the damage dealt
// when it is at (or above) its base level.
function buildSpecial(core) {
  const { CombatSpecial, ItemIdentifiers, RangedCombatMethod, Skill } = core;

  const DRAIN = 75;

  class DorgeshuunCrossbowCombatMethod extends RangedCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      super.start(character, target);
    }

    handleAfterHitEffects(hit) {
      if (!hit.isAccurate()) {
        return;
      }
      const damage = Math.max(0, Math.floor(hit.getTotalDamage()));
      if (damage <= 0) {
        return;
      }
      const target = hit.getTarget();
      const skillManager = target.isPlayer() ? target.getAsPlayer().getSkillManager() : target.getAsNpc();
      const current = skillManager.getCurrentLevel(Skill.DEFENCE);
      if (current < skillManager.getMaxLevel(Skill.DEFENCE)) return;
      skillManager.setCurrentLevels(Skill.DEFENCE, Math.max(target.isPlayer() ? 1 : 0, current - damage));
    }
  }

  return {
    id: "dorgeshuun_crossbow",
    itemIds: [ItemIdentifiers.DORGESHUUN_CROSSBOW],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1,
    traits: { guaranteedHitOnUnsuspectingTarget: true },
    combatMethod: new DorgeshuunCrossbowCombatMethod(),
  };
}

module.exports = function registerDorgeshuunCrossbowSpecialAttack(api) {
  api.registerCombatSpecial(buildSpecial(api.core));
};
