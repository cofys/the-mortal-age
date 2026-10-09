module.exports = function registerVolatileNightmareStaffSpecialAttack(api) {
  const { Animation, CombatMethod, CombatSpecial, CombatType, DamageFormulas, Graphic, ItemIdentifiers, MagicCombatMethod, Misc, PendingHit } = api.core;

  const DRAIN = 55;
  // Immolate (cache): nightmare_staff_special, nightmare_staff_volatile_cast_spotanim on the caster and
  // nightmare_staff_volatile_hit_spotanim on the target. It has no projectile (Wiki).
  const CAST_ANIMATION = new Animation(8532);
  const CAST_GRAPHIC = new Graphic(1760);
  const HIT_GRAPHIC = new Graphic(1759);

  class VolatileNightmareStaffCombatMethod extends CombatMethod {
    hits(character, target) {
      const hit = new PendingHit(character, target, this, 2);
      if (hit.isAccurate() && character.isPlayer()) {
        const player = character.getAsPlayer();
        const maxHit = DamageFormulas.getVolatileNightmareStaffBaseMaxHit(player);
        const hitRoll = Misc.randomInclusive(1, maxHit);
        hit.setTotalDamage(DamageFormulas.applyMagicDamageBonus(character, hitRoll));
      }
      return [hit];
    }

    canAttack(character, target) {
      if (!character.isPlayer()) {
        return false;
      }
      return character.getAsPlayer().getEquipment().getWeapon().getId() === ItemIdentifiers.VOLATILE_NIGHTMARE_STAFF;
    }

    type() {
      return CombatType.MAGIC;
    }

    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performAnimation(CAST_ANIMATION);
      character.performGraphic(CAST_GRAPHIC);
    }

    handleAfterHitEffects(hit) {
      hit.getTarget().performGraphic(hit.isAccurate() ? HIT_GRAPHIC : MagicCombatMethod.SPLASH_GRAPHIC);
    }

    attackSpeed(character) {
      return 5;
    }

    attackDistance(character) {
      return 10;
    }

    finished(character, target) {
      // Without false, the reset animation would cancel the cast on the same tick.
      character.getCombat().reset(false);
      // reset() clears the interaction; a resolved cast still faces its target.
      character.setMobileInteraction(target);
      character.getMovementQueue().reset();
    }
  }

  api.registerCombatSpecial({
    id: "volatile_nightmare_staff",
    itemIds: [ItemIdentifiers.VOLATILE_NIGHTMARE_STAFF],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1.5,
    combatMethod: new VolatileNightmareStaffCombatMethod(),
  });
};
