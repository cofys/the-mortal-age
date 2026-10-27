// Hammer Blow: https://oldschool.runescape.wiki/w/Granite_hammer#Special_attack
let core;
const SPECIAL_ID = "granite_hammer";
const DAMAGE_BONUS = 5;

/** Failed accuracy still deals the flat bonus, through the usual damage reductions. */
function missedHammerBlow({ attacker, target, combatType, damage, accurate }) {
  if (accurate || combatType !== core.CombatType.MELEE || !attacker.isPlayer() || !attacker.isSpecialActivated() ||
      attacker.getCombatSpecial()?.getId() !== SPECIAL_ID) return;
  const bounds = { minimumMultiplier: 0, maximumMultiplier: 0, minimumBonus: DAMAGE_BONUS, maximumBonus: DAMAGE_BONUS };
  damage.setDamage(core.CombatFactory.getHitDamage(attacker, target, combatType, false, bounds).getDamage());
}

module.exports = function registerGraniteHammerSpecialAttack(api) {
  core = api.core;
  const { CombatSpecial, Graphic, ItemIdentifiers, MeleeCombatMethod } = api.core;

  const DRAIN = 60;
  // The dedicated animation has no indexed recording; retain the existing swing pending evidence.
  const SPECIAL_VFX = new Graphic(1450);
  const ACCURACY_MULTIPLIER = 1.5;

  class GraniteHammerCombatMethod extends MeleeCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      super.start(character, target);
      character.performGraphic(SPECIAL_VFX);
    }
  }

  api.registerCombatSpecial({
    id: SPECIAL_ID,
    itemIds: [
      ItemIdentifiers.GRANITE_HAMMER,
      ItemIdentifiers.GRANITE_HAMMER_2,
      ItemIdentifiers.GRANITE_HAMMER_3,
    ],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: ACCURACY_MULTIPLIER,
    traits: {
      hitCount: 1,
      accuracyMultiplier: ACCURACY_MULTIPLIER,
      minimumDamageBonus: DAMAGE_BONUS,
      maximumDamageBonus: DAMAGE_BONUS,
    },
    combatMethod: new GraniteHammerCombatMethod(),
  });
  api.onCombatHitDamage(missedHammerBlow);
};
