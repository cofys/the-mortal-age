/**
 * Pocket Kingdom (https://oldschool.runescape.wiki/w/Pocket_Kingdom), Raging Echoes' tier 7 relic:
 * Managing Miscellania from anywhere through the Pocket kingdom (Check, Collect, Manage-kingdom),
 * without the quests and with Royal Trouble's enhancements; the workers cost half the coins,
 * gather twice as much, and approval is held at its maximum.
 * Not here: the hourly cycle (and its 37,500 coins an hour once the coffers hold 375,000); the
 * kingdom still works by the day, as it does for everyone else.
 */
const Common = require("./Common.LeagueRelics");

let api;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function rules(request) {
  if (!active(request.player)) return;
  request.ruler = true;
  request.royalTrouble = true;
  request.payMultiplier *= effect.payMultiplier;
  request.outputMultiplier *= effect.outputMultiplier;
  request.approval = effect.approval;
  // Managed from anywhere: each catch-up (a login, the item's options) is a visit, so the subjects keep working.
  request.visiting = true;
}

function ask(name) {
  return ({ player }) => {
    if (active(player)) api.emitCustomEvent(name, { player, handled: false, opened: false });
  };
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  effect = Common.data.effects.pocketKingdom;
  api.onCustomEvent("miscellania:rules", rules);
  api.onItemAction(effect.toolName, {
    Check: ask("miscellania:check"),
    Collect: ask("miscellania:collect"),
    "Manage-kingdom": ask("miscellania:open"),
  });
};
