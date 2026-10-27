/**
 * The attack rate masteries (Melee/Ranged/Magic III and V): tier 3 sets the style's attack rate
 * to 80% rounding down; tier 5 to 50%, rounded down from 5 ticks and rounded up below (Wiki), and
 * supersedes tier 3. Asked after the weapon's, spell's or special's own speed (`onAttackSpeed`),
 * never below a tick.
 */
const Common = require("./Common.LeagueCombatMasteries");

function attackSpeed(event) {
  const styleKey = Common.styleOfCombatType(event.combatType);
  if (!styleKey) return;
  const half = Common.effect(event.attacker, styleKey, 5);
  const rate = half ?? Common.effect(event.attacker, styleKey, 3);
  if (!rate) return;
  const scaled = event.speed * rate.attackRate;
  const rounded = half && event.speed < half.roundDownFrom ? Math.ceil(scaled) : Math.floor(scaled);
  event.speed = Math.max(1, rounded);
}

module.exports = function attach(api) {
  api.onAttackSpeed(attackSpeed);
};
