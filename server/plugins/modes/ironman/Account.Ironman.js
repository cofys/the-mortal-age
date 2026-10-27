/**
 * The account type on login: its varbits, and the chat icon StaffCrowns asks for. Another plugin
 * sets a mode with `ironman:set-mode` { player, mode } (a game mode whose characters are always
 * Ironmen, say); the in-game choice is Setup.Ironman.js.
 */
const Common = require("./Common.Ironman");

function login({ player }) {
  Common.sendVarbits(player);
}

function chatIcon(request) {
  const icon = Common.data.modes[Common.modeOf(request.player)].icon;
  if (Number.isInteger(icon)) request.icon = icon;
}

/** `ironman:set-mode` { player, mode }: sets a mode the data knows; `handled` says it did. */
function setMode(request) {
  const { player, mode } = request ?? {};
  if (!player || !Common.data.modes[mode]) return;
  Common.setMode(player, mode);
  request.handled = true;
}

module.exports = function attach(api) {
  api.persistAttribute(Common.MODE_ATTRIBUTE);
  api.persistAttribute(Common.HARDCORE_DEAD_ATTRIBUTE);
  api.onPlayerLogin(login);
  api.onCustomEvent("account:chat-icon", chatIcon);
  api.onCustomEvent("ironman:set-mode", setMode);
};
