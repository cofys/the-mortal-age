/**
 * Production Master (https://oldschool.runescape.wiki/w/Production_Master), Raging Echoes' tier 5
 * relic: the Wiki's listed production activities make everything at once (the ammunition, 10
 * times the usual a cycle), with full XP. No level boost and no extra product: those were
 * Trailblazer Reloaded's Production Prodigy.
 */
const Common = require("./Common.LeagueRelics");

let effect;

function allAtOnce(request) {
  if (!Common.effectActive(request.player, effect)) return;
  const actions = Common.batchActions(effect, request);
  if (actions) request.actions = Math.max(request.actions, actions);
}

module.exports = function attach(api) {
  effect = Common.data.effects.productionMaster;
  api.onCustomEvent("skills:actions-per-cycle", allAtOnce);
};
