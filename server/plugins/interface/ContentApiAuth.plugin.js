"use strict";

/**
 * ContentApiAuth plugin — issues per-session tokens for Content API authentication.
 *
 * On player login, generates a secure token and sends it to the client over the
 * authenticated game WebSocket via a filtered system message. The client includes
 * the token in Content API requests. API endpoints validate via ContentApiAuth.requireAuth().
 *
 * On logout, the token is revoked.
 */

const ContentApiAuth = require("./ContentApiAuth");

function onLogin({ player }) {
  try {
    // Skip bots — they don't use the web client
    if (player?.isPlayerBot?.() === true) return;
    ContentApiAuth.issueToken(player);
  } catch (e) {
    console.error("[content-api-auth] failed to issue token on login", e);
  }
}

function onLogout({ player }) {
  try {
    const username = player?.getUsername?.() || player?.username;
    if (username) {
      ContentApiAuth.revokeToken(username);
    }
  } catch (e) {
    console.error("[content-api-auth] failed to revoke token on logout", e);
  }
}

module.exports = {
  name: "ContentApiAuth",
  register(api) {
    ContentApiAuth.setPluginApi(api);
    api.onPlayerLogin(onLogin);
    // onPlayerLogout may not exist — guard it
    try {
      if (typeof api.onPlayerLogout === "function") {
        api.onPlayerLogout(onLogout);
      }
    } catch {
      // Hook not available, tokens expire via TTL
    }
  },
};
