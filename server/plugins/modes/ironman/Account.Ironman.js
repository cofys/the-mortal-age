/** The account type on login: its varbits, and the chat icon StaffCrowns asks for. */
const Common = require("./Common.Ironman");

function login({ player }) {
  Common.sendVarbits(player);
}

function chatIcon(request) {
  const icon = Common.data.modes[Common.modeOf(request.player)].icon;
  if (Number.isInteger(icon)) request.icon = icon;
}

module.exports = function attach(api) {
  api.persistAttribute(Common.MODE_ATTRIBUTE);
  api.persistAttribute(Common.HARDCORE_DEAD_ATTRIBUTE);
  api.onPlayerLogin(login);
  api.onCustomEvent("account:chat-icon", chatIcon);
};
