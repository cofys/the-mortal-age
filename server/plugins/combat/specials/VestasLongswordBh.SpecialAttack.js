// Feint's animation is the longsword Lunge thrust (412); the cache has no Feint seq of its own.
module.exports = function registerVestasLongswordBhSpecialAttack(api) {
  const { Animation, CombatSpecial, ItemIdentifiers, MeleeCombatMethod } = api.core;

  const DRAIN = 25;
  const ANIMATION = new Animation(412);

  class VestasLongswordBhCombatMethod extends MeleeCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performAnimation(ANIMATION);
    }
  }

  api.registerCombatSpecial({
    id: "vestas_longsword_bh",
    itemIds: [
      ItemIdentifiers.VESTAS_LONGSWORD_BH_,
      ItemIdentifiers.VESTAS_BLIGHTED_LONGSWORD,
    ],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1,
    traits: {
      hitCount: 1,
      accuracyMultiplier: 1,
      damageMultiplier: 1,
      minimumDamageMultiplier: 0.2,
      maximumDamageMultiplier: 1.2,
      meleeDefenceBonusIndex: 0,
      defenceRollMultiplier: 0.25,
    },
    combatMethod: new VestasLongswordBhCombatMethod(),
  });
};
