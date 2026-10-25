const Common = require('./Common.ElementalSpells');
function baseMaximum(request) {
  const player = request.attacker;
  if (!player?.isPlayer?.()) return;
  const entry = Common.metadata(request.spell);
  if (!entry) return;
  const level = player.getSkillManager().getMaxLevel(Common.core.Skill.MAGIC);
  // Add the scaling delta so other base additions commute with this handler.
  request.maxHit += Common.familyMaximum(entry, level) - request.originalMaxHit;
  if (Common.matchingAmulet(player, entry.element)) request.maxHit += 2;
}
function attach(api) { api.onCustomEvent('combat:magic-base-max-hit', baseMaximum); }
module.exports = { attach };
