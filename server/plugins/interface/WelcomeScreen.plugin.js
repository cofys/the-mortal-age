const WELCOME_SCREEN_GROUP_ID = 378;
const PLAY_BUTTON_UID = (WELCOME_SCREEN_GROUP_ID << 16) | 72;
const FIRST_OPTION_FLAG = 1 << 1;
const pending = new WeakSet();
const visible = new WeakSet();
let api;

function inWilderness(player) {
  return api.core.Wilderness.isInLocation(player?.getLocation?.());
}

function login({ player, isNewAccount }) {
  // Mobile, new accounts and Wilderness logins enter the world directly.
  if (isNewAccount || player.isPlayerBot?.() === true || inWilderness(player)
      || player.getAttribute(api.core.MOBILE_CLIENT_ATTRIBUTE) === true) return;
  pending.add(player);
  // The synchronous login bootstrap initializes camera, chat and account varcs first.
  queueMicrotask(() => showWelcomeScreen(player));
}

function showWelcomeScreen(player) {
  if (!pending.delete(player) || inWilderness(player)) return;
  visible.add(player);
  const sender = player.getPacketSender();
  sender.sendRootInterface(WELCOME_SCREEN_GROUP_ID);
  sender.sendInterfaceFlags(PLAY_BUTTON_UID, FIRST_OPTION_FLAG);
  api.emitCustomEvent("welcome-screen:shown", { player });
}

function play({ player }) {
  if (!visible.delete(player)) return false;
  const root = api.core.resolveGameframeRoot(player);
  for (const packet of api.core.encodeGameframeBootstrap(player.getUsername(), root,
      player.getAttribute(api.core.XPDROPS_ENABLED_ATTRIBUTE) === true)) {
    player.getSession().sendClientPacket(packet);
  }
  // The saved spellbook selector and quest varps were sent at login and survive a root swap.
  api.emitCustomEvent("gameframe:ready", { player });
  return false;
}

function clear({ player }) {
  pending.delete(player);
  visible.delete(player);
}

// Web overlay data layers: the new-player guide (see OnboardingApi.js) and the
// steward's desk (see StewardApi.js). They need the content-endpoint surface;
// a boot without it (e.g. a minimal test harness) skips them instead of
// failing the welcome screen's own registration.
function attachOverlays(pluginApi) {
  if (typeof pluginApi.registerContentEndpoint !== "function") return;
  require("./OnboardingApi").attach(pluginApi);
  require("./StewardApi").attach(pluginApi);
}

module.exports = {
  name: "WelcomeScreen",
  dependsOn: ["Wilderness"],
  register(pluginApi) {
    api = pluginApi;
    api.onPlayerLogin(login);
    api.onInterfaceActionButton(PLAY_BUTTON_UID, play);
    attachOverlays(api);
    api.onPlayerDisconnect(clear);
    api.onPlayerLogout(clear);
    api.log("registered");
  },
};
