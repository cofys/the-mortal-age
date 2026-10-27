/**
 * Treasure Arbiter (https://oldschool.runescape.wiki/w/Treasure_Arbiter), Raging Echoes' tier 5
 * relic: the shared clue perks (1 in 15 clue scrolls, 10 times the clue vessels, the fewest steps,
 * the most casket rolls), and emote, Falo the Bard and Charlie the Tramp steps ask for no items
 * (any item shown to Falo is the right one).
 */
const Common = require("./Common.LeagueRelics");
const attachClues = require("./Clues.LeagueRelics");

let effect;

function waive(request) {
  if (effect.waived.includes(request.kind) && Common.effectActive(request.player, effect)) request.waived = true;
}

module.exports = function attach(api) {
  effect = Common.data.effects.treasureArbiter;
  attachClues(api, effect);
  api.onCustomEvent("treasure-trails:requirement-waived", waive);
};
