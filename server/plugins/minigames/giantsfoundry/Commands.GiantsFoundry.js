"use strict";

/** Developer commands for testing the foundry. */

const Shared = require("./Shared.GiantsFoundry");

/** ::foundryrep <amount> - sets your Foundry Reputation. */
function setReputation({ player, parts }) {
  const value = Number(parts?.[1]);
  if (!Number.isFinite(value) || value < 0) {
    player.sendMessage("Use ::foundryrep <amount>.");
    return true;
  }
  Shared.setReputation(player, value);
  player.sendMessage(`Foundry Reputation: ${Shared.reputation(player)}`);
  return true;
}

module.exports = function attachCommands(api) {
  const { DEVELOPER } = api.core.PlayerRights;
  api.registerCommand("foundryrep", setReputation, DEVELOPER, "Set your Giants' Foundry reputation");
};
