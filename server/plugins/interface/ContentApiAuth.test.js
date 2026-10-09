"use strict";

// ContentApiAuth unit checks — per-session token authentication for Content API.
// From server/: node plugins/interface/ContentApiAuth.test.js (plain node, no server).
const assert = require("node:assert/strict");
const path = require("node:path");

const AUTH_PATH = path.resolve(__dirname, "ContentApiAuth.js");
const ContentApiAuth = require(AUTH_PATH);

// Mock plugin API
const mockPlayers = new Map();
const mockApi = {
  core: {
    World: {
      getPlayerByName: (name) => mockPlayers.get(String(name).toLowerCase()) || null,
    },
  },
};

function mockPlayer(username, isBot = false) {
  return {
    getUsername: () => username,
    username,
    isPlayerBot: () => isBot,
    sendMessage: () => {}, // Mock — token sent via WebSocket
  };
}

function mockQuery(params) {
  const map = new Map(Object.entries(params));
  return {
    get: (key) => map.get(key) ?? null,
  };
}

function reset() {
  ContentApiAuth.setPluginApi(mockApi);
  mockPlayers.clear();
  ContentApiAuth._tokenToSession.clear();
  ContentApiAuth._userToToken.clear();
}

// --- issue token -----------------------------------------------------------
reset();
{
  const player = mockPlayer("TestUser");
  mockPlayers.set("testuser", player);
  const token = ContentApiAuth.issueToken(player);
  assert(token, "Token should be issued");
  assert.strictEqual(typeof token, "string");
  assert(token.length >= 64, "Token should be 64+ hex chars (32 bytes)");
  console.log("ok - issues a token on login");
}

// --- validate valid token --------------------------------------------------
reset();
{
  const player = mockPlayer("TestUser");
  mockPlayers.set("testuser", player);
  const token = ContentApiAuth.issueToken(player);
  const authed = ContentApiAuth.requireAuth(mockQuery({ token }));
  assert(authed, "Valid token should authenticate");
  assert.strictEqual(authed.getUsername(), "TestUser");
  console.log("ok - validates a valid token via requireAuth");
}

// --- reject missing token --------------------------------------------------
reset();
{
  const authed = ContentApiAuth.requireAuth(mockQuery({}));
  assert.strictEqual(authed, null, "Missing token should not authenticate");
  console.log("ok - rejects missing token");
}

// --- reject invalid token --------------------------------------------------
reset();
{
  const authed = ContentApiAuth.requireAuth(mockQuery({ token: "invalid-token-123" }));
  assert.strictEqual(authed, null, "Invalid token should not authenticate");
  console.log("ok - rejects invalid token");
}

// --- reject token for offline player ---------------------------------------
reset();
{
  const player = mockPlayer("TestUser");
  mockPlayers.set("testuser", player);
  const token = ContentApiAuth.issueToken(player);
  mockPlayers.delete("testuser"); // Player goes offline
  const authed = ContentApiAuth.requireAuth(mockQuery({ token }));
  assert.strictEqual(authed, null, "Token for offline player should not authenticate");
  console.log("ok - rejects token for offline player");
}

// --- revoke on logout ------------------------------------------------------
reset();
{
  const player = mockPlayer("TestUser");
  mockPlayers.set("testuser", player);
  const token = ContentApiAuth.issueToken(player);
  ContentApiAuth.revokeToken("TestUser");
  const authed = ContentApiAuth.requireAuth(mockQuery({ token }));
  assert.strictEqual(authed, null, "Revoked token should not authenticate");
  console.log("ok - revokes token on logout");
}

// --- new token on re-login -------------------------------------------------
reset();
{
  const player = mockPlayer("TestUser");
  mockPlayers.set("testuser", player);
  const token1 = ContentApiAuth.issueToken(player);
  const token2 = ContentApiAuth.issueToken(player);
  assert.notStrictEqual(token1, token2, "New login should issue new token");
  assert.strictEqual(
    ContentApiAuth.requireAuth(mockQuery({ token: token1 })),
    null,
    "Old token should be revoked"
  );
  assert(
    ContentApiAuth.requireAuth(mockQuery({ token: token2 })),
    "New token should work"
  );
  console.log("ok - issues new token on re-login (old revoked)");
}

// --- bots cannot authenticate ----------------------------------------------
reset();
{
  const bot = mockPlayer("BotUser", true);
  mockPlayers.set("botuser", bot);
  const token = ContentApiAuth.issueToken(bot);
  const authed = ContentApiAuth.requireAuth(mockQuery({ token }));
  assert.strictEqual(authed, null, "Bot tokens should not authenticate via findPlayer");
  console.log("ok - bots cannot authenticate");
}

// --- token expiry ----------------------------------------------------------
reset();
{
  const player = mockPlayer("TestUser");
  mockPlayers.set("testuser", player);
  const token = ContentApiAuth.issueToken(player);
  // Manually expire by backdating
  const session = ContentApiAuth._tokenToSession.get(token);
  session.createdAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
  const authed = ContentApiAuth.requireAuth(mockQuery({ token }));
  assert.strictEqual(authed, null, "Expired token should not authenticate");
  console.log("ok - expires tokens after TTL");
}

console.log("\nAll ContentApiAuth tests passed!");
