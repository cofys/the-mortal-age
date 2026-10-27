"use strict";

const Rolls = require("./Rolls.RewardCaskets");

let api = null;

/** Mutable response: { player, tier, rolls, drops:null, handled:false, error:null }. */
function rollCasket(request) {
  if (!request || request.handled) return;
  try {
    request.drops = Rolls.roll(request.tier, request.rolls, Math.random, Rolls.uniqueMultiplier(api, request.player));
    request.handled = true;
  } catch (error) {
    request.error = error;
  }
}

function init(pluginApi) {
  api = pluginApi;
}

module.exports = {
  name: "RewardCaskets",
  members: true,
  register(api) {
    init(api);
    api.onCustomEvent("treasure-trails:roll-casket", rollCasket);
  },
};
