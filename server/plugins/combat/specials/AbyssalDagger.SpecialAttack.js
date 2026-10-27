function buildSpecial(core, imbued = false) {
  const { Animation, CombatSpecial, Graphic, ItemIdentifiers, MeleeCombatMethod, Priority, Sounds } = core;

  const DRAIN = imbued ? 35 : 25;
  const ACCURACY_MULTIPLIER = 1.25;
  const DAMAGE_MULTIPLIER = imbued ? 0.95 : 0.85;
  const SLASH_DEFENCE_BONUS_INDEX = 1;
  const ANIMATION = new Animation(3300);
  const GRAPHIC = new Graphic(1283, Priority.HIGH);

  class AbyssalDaggerCombatMethod extends MeleeCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performAnimation(ANIMATION);
      character.performGraphic(GRAPHIC);
      Sounds.sendSound(character, character.getAttackSound());
    }
  }

  return {
    id: imbued ? "abyssal_dagger_bh" : "abyssal_dagger",
    itemIds: imbued ? [
      ItemIdentifiers.ABYSSAL_DAGGER_BH_,
      ItemIdentifiers.ABYSSAL_DAGGER_BH_P_,
      ItemIdentifiers.ABYSSAL_DAGGER_BH_P_PLUS_,
      ItemIdentifiers.ABYSSAL_DAGGER_BH_P_PLUS_PLUS_,
    ] : [
      ItemIdentifiers.ABYSSAL_DAGGER,
      ItemIdentifiers.ABYSSAL_DAGGER_P_,
      ItemIdentifiers.ABYSSAL_DAGGER_P_PLUS_,
      ItemIdentifiers.ABYSSAL_DAGGER_P_PLUS_PLUS_,
    ],
    drainAmount: DRAIN,
    strengthMultiplier: DAMAGE_MULTIPLIER,
    accuracyMultiplier: ACCURACY_MULTIPLIER,
    traits: {
      hitCount: 2,
      accuracyMultiplier: ACCURACY_MULTIPLIER,
      damageMultiplier: DAMAGE_MULTIPLIER,
      meleeDefenceBonusIndex: SLASH_DEFENCE_BONUS_INDEX,
      sharedAccuracyRollAcrossHits: true,
    },
    combatMethod: new AbyssalDaggerCombatMethod(),
  };
}

module.exports = function registerAbyssalDaggerSpecialAttack(api) {
  api.registerCombatSpecial(buildSpecial(api.core));
  api.registerCombatSpecial(buildSpecial(api.core, true));
};
