"use strict";

/** Developer commands for testing the lab. */

const Shared = require("./Shared.Mixology");
const Digweed = require("./Digweed.Mixology");

/** ::resin <mox> [aga] [lye] - sets your resin (one number sets all three). */
function setResin({ player, parts }) {
  const amounts = parts.slice(1, 4).map(Number);
  if (!amounts.length || amounts.some((value) => !Number.isFinite(value) || value < 0)) {
    player.sendMessage("Use ::resin <mox> [aga] [lye].");
    return true;
  }
  Shared.REAGENTS.forEach((reagent, index) => Shared.setResin(player, reagent, amounts[index] ?? amounts[0]));
  player.sendMessage(`Resin: ${Shared.REAGENTS.map((reagent) => Shared.resin(player, reagent)).join("/")}`);
  return true;
}

/** ::digweed - a digweed patch matures on the next tick. */
function matureDigweed({ player }) {
  Shared.set(player, Shared.VARBIT.ORDERS_SINCE_HERB, Digweed.threshold(player));
  Digweed.afterHandIn(player);
  player.sendMessage("A digweed patch will mature shortly.");
  return true;
}

module.exports = function attachCommands(api) {
  const { DEVELOPER } = api.core.PlayerRights;
  api.registerCommand("resin", setResin, DEVELOPER, "Set your Mastering Mixology resin");
  api.registerCommand("digweed", matureDigweed, DEVELOPER, "Mature a Mastering Mixology digweed patch");
};
