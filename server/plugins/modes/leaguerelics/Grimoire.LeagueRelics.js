/**
 * Grimoire (https://oldschool.runescape.wiki/w/Grimoire_(Raging_Echoes_League)), Raging Echoes'
 * tier 7 relic: every spell's area, quest or diary requirement is lifted (`magic:spell-unlocked`:
 * here, the Mage Arena's god spells outside the arena without their 100 casts). The Prayer level
 * itself still counts (Wiki), and this server gates no prayer by quest. Not here: the Arcane
 * grimoire's spellbook swap (the item's own plugin, Leagues polish).
 */
const Common = require("./Common.LeagueRelics");

let effect;

function unlocked(request) {
  if (Common.effectActive(request.player, effect)) request.unlocked = true;
}

module.exports = function attach(api) {
  effect = Common.data.effects.grimoire;
  api.onCustomEvent("magic:spell-unlocked", unlocked);
};
