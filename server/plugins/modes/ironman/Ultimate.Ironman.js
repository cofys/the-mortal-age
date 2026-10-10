/**
 * Ultimate Ironmen can't use the bank, and drop all their items when they die (the Ironman tutor:
 * "Ultimate Ironmen are blocked from using the bank, and they drop all their items when they die").
 */
const Common = require("./Common.Ironman");

function bank(event) {
  if (Common.modeOf(event.player) !== "ultimate") return;
  event.allow = false;
  event.player.sendMessage(Common.message("ultimateBank"));
}

function keepOnDeath(event) {
  if (Common.modeOf(event.player) === "ultimate") event.keep = false;
}

module.exports = function attach(api) {
  api.onCanBank(bank);
  api.onShouldKeepItemOnDeath(keepOnDeath);
};
