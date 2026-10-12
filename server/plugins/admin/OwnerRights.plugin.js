"use strict";

/**
 * OwnerRights — grants Jon (username "Cofy", case-insensitive) OWNER rights on login.
 *
 * Jon runs the server and needs admin commands, but his account has no rights.
 * On every login, if the username matches, both the live session and the persisted
 * save get OWNER rights, and the chat-icon refresh event fires so the crown shows
 * immediately (StaffCrowns may have read the old rights before this hook ran).
 */

const OWNER_USERNAME = "cofy";

let pluginApi = null;

function grantOwnerRights({ player }) {
  if (!player) return;
  const username = player.getUsername?.();
  if (typeof username !== "string" || username.toLowerCase() !== OWNER_USERNAME) return;

  const { PlayerRights } = pluginApi.core;
  const current = player.getRights?.();
  if (current === PlayerRights.OWNER) return;

  player.setRights(PlayerRights.OWNER);
  try {
    player.getSave?.()?.setRights?.(PlayerRights.OWNER);
  } catch {
    // Save not attached yet; the live-session rights still apply this session.
  }
  pluginApi.emitCustomEvent("account:refresh-chat-icons", { player });
  console.log(`[owner-rights] Granted OWNER rights to ${username}`);
}

module.exports = {
  name: "OwnerRights",
  register(api) {
    pluginApi = api;
    api.onPlayerLogin(grantOwnerRights);
  },
};
