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

function packSet(request) {
  if (Common.modeOf(request.player) !== "ultimate") return;
  request.allow = false;
  request.player.sendMessage("Ultimate Ironmen cannot pack item sets.");
}

module.exports = function attach(api) {
  api.onCanBank(bank);
  api.onShouldKeepItemOnDeath(keepOnDeath);
  api.onCustomEvent("item-sets:can-pack", packSet);
};
