// Favour of the War God (Wiki: Ancient mace): hits through Protect from Melee, NPC melee
// prayers included (22 October 2025 update), rolls against crush defence in every style,
// drains the target's Prayer by the damage and restores the user's by the same amount.
const ID = "ancient_mace";
const DRAIN = 100;
const CRUSH_DEFENCE_BONUS_INDEX = 2;

let core;

function favouring(attacker) {
  return attacker?.isPlayer?.() === true
    && attacker.getAsPlayer().isSpecialActivated()
    && attacker.getAsPlayer().getCombatSpecial()?.getId() === ID;
}

/** NPC prayers only yield to a hit its roll hook marked; the trait covers players. */
function pierceNpcMeleePrayer(roll) {
  if (roll.combatType === core.CombatType.MELEE && favouring(roll.attacker)) {
    roll.bypassProtectionPrayer = true;
  }
}

function favour(hit) {
  if (!hit.isAccurate()) {
    return;
  }
  const damage = Math.max(0, Math.floor(hit.getTotalDamage()));
  if (damage <= 0) {
    return;
  }

  const { Skill } = core;
  const target = hit.getTarget();
  if (target.isPlayer()) {
    const targetSkills = target.getAsPlayer().getSkillManager();
    const currentPrayer = targetSkills.getCurrentLevel(Skill.PRAYER);
    targetSkills.setCurrentLevels(Skill.PRAYER, Math.max(0, currentPrayer - damage));
  }

  const attacker = hit.getAttacker();
  if (attacker.isPlayer()) {
    const skills = attacker.getAsPlayer().getSkillManager();
    const currentPrayer = skills.getCurrentLevel(Skill.PRAYER);
    const prayerCap = skills.getMaxLevel(Skill.PRAYER) + damage;
    skills.setCurrentLevels(Skill.PRAYER, Math.min(prayerCap, currentPrayer + damage));
  }
}

module.exports = function registerAncientMaceSpecialAttack(api) {
  core = api.core;
  const { Animation, CombatSpecial, Graphic, ItemIdentifiers, MeleeCombatMethod, Sounds } = api.core;

  // Cache gamevals slice_player_mace_special_attack / slice_player_mace_special_attack_spotanim.
  const ANIMATION = new Animation(6147);
  const GRAPHIC = new Graphic(1052);

  class AncientMaceCombatMethod extends MeleeCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performAnimation(ANIMATION);
      character.performGraphic(GRAPHIC);
      Sounds.sendSound(character, character.getAttackSound());
    }

    handleAfterHitEffects(hit) {
      favour(hit);
    }
  }

  api.registerCombatSpecial({
    id: ID,
    itemIds: [ItemIdentifiers.ANCIENT_MACE],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1,
    traits: {
      hitCount: 1,
      meleeDefenceBonusIndex: CRUSH_DEFENCE_BONUS_INDEX,
      ignoreProtectionPrayer: true,
    },
    combatMethod: new AncientMaceCombatMethod(),
  });
  api.onCombatHitRoll(pierceNpcMeleePrayer);
};
