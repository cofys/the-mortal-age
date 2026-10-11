// Run after `yarn build`: node --test tests/mcp-developer-rights.test.cjs
const assert = require("node:assert/strict");
const { test, after } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { PlayerRights } = require("../dist/game/model/rights/PlayerRights");
const Plugin = require("../plugins/agent/AgentMcp.plugin");

// Register with MCP off so no HTTP listener starts; the hooks read the env when they run.
const hooks = {}, events = [];
const previousEnv = process.env.AGENT_MCP;
process.env.AGENT_MCP = "0";
Plugin.register({
  core: { PlayerRights },
  onServerShutdown: handler => { hooks.shutdown = handler; },
  onPlayerLogin: handler => { hooks.login = handler; },
  onPlayerLogout: handler => { hooks.logout = handler; },
  emitCustomEvent: (name, event) => events.push([name, event.player]),
});
process.env.AGENT_MCP = "1";
after(() => {
  if (previousEnv === undefined) delete process.env.AGENT_MCP;
  else process.env.AGENT_MCP = previousEnv;
});

function player(rights) {
  const p = { rights, getRights: () => p.rights, setRights: value => { p.rights = value; } };
  return p;
}

test("with MCP enabled a login becomes a developer and the real rank comes back on logout", () => {
  const p = player(PlayerRights.NONE);
  hooks.login({ player: p });
  assert.equal(p.rights, PlayerRights.DEVELOPER);
  assert.deepEqual(events.at(-1), ["account:refresh-chat-icons", p], "the crown refreshes");
  hooks.logout({ player: p });
  assert.equal(p.rights, PlayerRights.NONE, "the save must keep the real rank");
});

test("staff ranks survive an MCP session unchanged", () => {
  const p = player(PlayerRights.MODERATOR);
  hooks.login({ player: p });
  assert.equal(p.rights, PlayerRights.DEVELOPER);
  hooks.logout({ player: p });
  assert.equal(p.rights, PlayerRights.MODERATOR);
});

test("a repeated login hook keeps the original rank, not the developer grant", () => {
  const p = player(PlayerRights.MODERATOR);
  hooks.login({ player: p });
  hooks.login({ player: p });
  hooks.logout({ player: p });
  assert.equal(p.rights, PlayerRights.MODERATOR);
});

test("without MCP the hooks leave every rank alone", () => {
  process.env.AGENT_MCP = "0";
  const p = player(PlayerRights.NONE);
  hooks.login({ player: p });
  assert.equal(p.rights, PlayerRights.NONE);
  hooks.logout({ player: p });
  assert.equal(p.rights, PlayerRights.NONE);
  process.env.AGENT_MCP = "1";
});
