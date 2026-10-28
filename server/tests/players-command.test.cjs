// Run after `yarn build`: node --test tests/players-command.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const PlayerCommands = require("../plugins/commands/PlayerCommands.plugin");

test("::players lists connected real players and leaves bots out", () => {
  const online = (username, bot = false) => ({ getUsername: () => username, isPlayerBot: () => bot });
  const players = [online("Zed"), online("Bot 1", true), online("Alice"), online("Gone")];
  const handlers = new Map();
  PlayerCommands.register({
    core: {},
    getWorld: () => ({ getPlayers: () => players, isPlayerSessionConnected: (p) => p.getUsername() !== "Gone" }),
    getItemOnGroundManager: () => ({}),
    getCombatFactory: () => ({}),
    getPlayerPunishment: () => ({}),
    registerCommand: (name, handler) => handlers.set(name, handler),
  });
  const messages = [];
  handlers.get("players")({ player: { sendMessage: (text) => messages.push(text) } });
  assert.deepEqual(messages, ["Online players (2):", "Alice, Zed"]);
});
