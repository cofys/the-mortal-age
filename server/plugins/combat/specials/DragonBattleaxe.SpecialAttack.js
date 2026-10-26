module.exports = function registerDragonBattleaxeSpecialAttack(api) {
  const { Animation, CombatMethod, CombatSpecial, CombatType, Graphic, ItemIdentifiers, Skill, Sound, Sounds } = api.core;

  const DRAIN = 100;
  const DRAIN_FRACTION = 0.1;
  const BASE_STRENGTH_BOOST = 10;
  const DRAIN_TO_STRENGTH_DIVISOR = 4;
  const ANIMATION = new Animation(1056);
  const GRAPHIC = new Graphic(246);
  const FORCED_CHAT = "Raarrrrrgggggghhhhhhh!";
  const DRAINED_SKILLS = [Skill.ATTACK, Skill.DEFENCE, Skill.RANGED, Skill.MAGIC];

  // Rampage is an instant utility special: drain 10% of Attack/Defence/Ranged/Magic,
  // then boost base Strength by 10 + a quarter of the total drained levels.
  // Visible boosts do not stack, and a stronger existing boost is preserved. No attack roll.
  class DragonBattleaxeCombatMethod extends CombatMethod {
    hits() {
      return null;
    }

    type() {
      return CombatType.MELEE;
    }

    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      if (!character.isPlayer()) {
        return;
      }
      character.forceChat(FORCED_CHAT);
      character.performAnimation(ANIMATION);
      character.performGraphic(GRAPHIC);
      Sounds.sendSound(character, Sound.DRAGON_BATTLEAXE_SPECIAL);
      const skillManager = character.getAsPlayer().getSkillManager();

      let totalDrained = 0;
      for (const skill of DRAINED_SKILLS) {
        const current = skillManager.getCurrentLevel(skill);
        const drainAmount = Math.max(0, Math.floor(current * DRAIN_FRACTION));
        skillManager.setCurrentLevels(skill, current - drainAmount);
        totalDrained += drainAmount;
      }

      const currentStrength = skillManager.getCurrentLevel(Skill.STRENGTH);
      const strengthBoost = Math.floor(
        BASE_STRENGTH_BOOST + Math.floor(totalDrained / DRAIN_TO_STRENGTH_DIVISOR),
      );
      const baseStrength = skillManager.getMaxLevel(Skill.STRENGTH);
      skillManager.setCurrentLevels(Skill.STRENGTH, Math.max(currentStrength, baseStrength + strengthBoost));
    }
  }

  api.registerCombatSpecial({
    id: "dragon_battleaxe",
    itemIds: [ItemIdentifiers.DRAGON_BATTLEAXE],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1,
    traits: { skipAttack: true },
    combatMethod: new DragonBattleaxeCombatMethod(),
  });
};
