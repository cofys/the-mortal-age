"use strict";

/**
 * ContentApiAuth — per-session token authentication for Content API endpoints.
 *
 * SECURITY FIX (P0): Content API endpoints (/api/*) previously identified players
 * by `?player=<username>` with zero authentication, allowing anyone to impersonate
 * any player and perform privileged actions (buy items, kick guild members, etc.).
 *
 * This module implements per-session token auth:
 * 1. On player login, a cryptographically secure token is generated
 * 2. The token is sent to the client over the authenticated game WebSocket
 *    via a filtered system message ([AUTH-TOKEN] prefix, hidden from chat)
 * 3. The client includes the token in API requests as `&token=<token>`
 * 4. API endpoints validate the token via `requireAuth(query)` before processing
 *
 * Tokens are invalidated on logout and expire after 24 hours.
 */

const crypto = require("crypto");

// token -> { username, createdAt }
const tokenToSession = new Map();
// username (lowercase) -> token
const userToToken = new Map();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTH_TOKEN_PREFIX = "[AUTH-TOKEN]";

let pluginApi = null;

function setPluginApi(api) {
  pluginApi = api;
}

/**
 * Generate a cryptographically secure session token for a player.
 * Called on player login. The token is sent to the client via a filtered
 * system message over the authenticated game WebSocket.
 */
function issueToken(player) {
  if (!player) return null;
  const username = getUsername(player);
  if (!username) return null;

  // Revoke any existing token for this user
  revokeToken(username);

  const token = crypto.randomBytes(32).toString("hex");
  const session = { username, createdAt: Date.now() };
  tokenToSession.set(token, session);
  userToToken.set(username.toLowerCase(), token);

  // Send token to client over authenticated WebSocket via filtered system message
  try {
    player.sendMessage(`${AUTH_TOKEN_PREFIX}${token}`);
  } catch (e) {
    // If sendMessage fails, clean up
    tokenToSession.delete(token);
    userToToken.delete(username.toLowerCase());
    return null;
  }

  return token;
}

/**
 * Revoke a player's session token. Called on logout.
 */
function revokeToken(username) {
  if (!username) return;
  const key = String(username).toLowerCase();
  const token = userToToken.get(key);
  if (token) {
    tokenToSession.delete(token);
    userToToken.delete(key);
  }
}

/**
 * Get the username from a player object.
 */
function getUsername(player) {
  try {
    return player.getUsername?.() || player.username || null;
  } catch {
    return null;
  }
}

/**
 * Find a player by username (excludes bots).
 */
function findPlayer(username) {
  const name = String(username ?? "").trim();
  if (!name || !pluginApi) return null;
  try {
    const player = pluginApi.core.World.getPlayerByName(name) || null;
    if (player?.isPlayerBot?.() === true) return null;
    return player;
  } catch {
    return null;
  }
}

/**
 * Validate the token from a Content API query.
 * Returns the authenticated player, or null if the token is missing/invalid/expired.
 *
 * Usage in API endpoints:
 *   const player = ContentApiAuth.requireAuth(query);
 *   if (!player) return { error: "unauthorized", open: false };
 */
function requireAuth(query) {
  const token = String(query.get("token") ?? "").trim();
  if (!token) return null;

  const session = tokenToSession.get(token);
  if (!session) return null;

  // Check expiry
  if (Date.now() - session.createdAt > TOKEN_TTL_MS) {
    tokenToSession.delete(token);
    userToToken.delete(session.username.toLowerCase());
    return null;
  }

  // Find the player and verify the username matches
  const player = findPlayer(session.username);
  if (!player) return null;

  return player;
}

/**
 * Get the current token for a username (for testing).
 */
function getTokenForUser(username) {
  if (!username) return null;
  return userToToken.get(String(username).toLowerCase()) || null;
}

/**
 * Clean up expired tokens. Called periodically.
 */
function cleanupExpired() {
  const now = Date.now();
  for (const [token, session] of tokenToSession) {
    if (now - session.createdAt > TOKEN_TTL_MS) {
      tokenToSession.delete(token);
      userToToken.delete(session.username.toLowerCase());
    }
  }
}

// Periodic cleanup every hour
setInterval(cleanupExpired, 60 * 60 * 1000).unref?.();

module.exports = {
  setPluginApi,
  issueToken,
  revokeToken,
  requireAuth,
  findPlayer,
  getTokenForUser,
  AUTH_TOKEN_PREFIX,
  // For testing
  _tokenToSession: tokenToSession,
  _userToToken: userToToken,
  _cleanupExpired: cleanupExpired,
};
