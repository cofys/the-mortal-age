// TODO: ported from xrsps-typescript; untested.
// A Pulverize that misses asks "combat-special:missed-drain" whether the target still loses some
// Defence (Tekton: 5%, https://oldschool.runescape.wiki/w/Elder_maul).
function buildSpecial(api) {
  const { Animation, CombatSpecial, Graphic, ItemIdentifiers, MeleeCombatMethod, Skill } = api.core;

  const ID = "elder_maul";
  const DRAIN = 50;
  const DEFENCE_DRAIN_FRACTION = 0.35;
  // Pulverize: dedicated player animation + self VFX + target impact (RuneLite
  // AnimationID HUMAN_ELDER_MAUL_SPEC / VFX_ELDER_MAUL_SPECIAL / ..._IMPACT).
  const SPECIAL_ANIMATION = new Animation(11124);
  const SPECIAL_VFX = new Graphic(2804);
  const IMPACT_GRAPHIC = new Graphic(2805);

  function pulverize(hit) {
    if (hit.isAccurate()) {
      drainDefence(hit.getTarget(), DEFENCE_DRAIN_FRACTION);
      return;
    }
    const missed = { hit, specialId: ID, fraction: 0, levels: 0 };
    api.emitCustomEvent("combat-special:missed-drain", missed);
    if (missed.fraction > 0) drainDefence(hit.getTarget(), missed.fraction);
  }

  function drainDefence(target, fraction) {
    const skillManager = target.isPlayer() ? target.getAsPlayer().getSkillManager() : target.getAsNpc();
    const current = skillManager.getCurrentLevel(Skill.DEFENCE);
    const drainAmount = Math.floor(current * fraction);
    skillManager.setCurrentLevels(Skill.DEFENCE, Math.max(target.isPlayer() ? 1 : 0, current - drainAmount));
  }

  class ElderMaulCombatMethod extends MeleeCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performAnimation(SPECIAL_ANIMATION);
      character.performGraphic(SPECIAL_VFX);
    }

    handleAfterHitEffects(hit) {
      if (hit.isAccurate()) {
        hit.getTarget().performGraphic(IMPACT_GRAPHIC);
      }
      pulverize(hit);
    }
  }

  return {
    id: ID,
    itemIds: [ItemIdentifiers.ELDER_MAUL, ItemIdentifiers.ELDER_MAUL_OR_],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1,
    // Pulverize's animation runs a tick slower than a normal elder maul attack.
    traits: { hitCount: 1, accuracyMultiplier: 1.25, attackSpeedTicks: 7 },
    combatMethod: new ElderMaulCombatMethod(),
  };
}

module.exports = function registerElderMaulSpecialAttack(api) {
  api.registerCombatSpecial(buildSpecial(api));
};
