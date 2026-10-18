// Run after `yarn build`: node --test tests/quests-bot-login.test.cjs
// The quests' login and death hooks skip bots (plugins/quests/Quests.plugin.js forPlayers): a bot
// has no client for quest progress and does no quests, and running ~160 login hooks made each bot
// login cost ~85 ms; bot deaths were worse per event (one quest scans every world NPC).
const assert = require("node:assert/strict");
const { before, test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const loginHooks = [];
const deathHooks = [];

before(async () => {
  await require("../dist/game/cache/CachePipeline").CachePipeline.initialize(require("node:path").resolve(__dirname, ".."));
  const { PluginManager } = require("../dist/plugins/PluginManager");
  const core = PluginManager.getCoreApi();
  // Every other api call is a no-op; only the login and death hooks are kept.
  const api = new Proxy({}, {
    get: (_, property) => {
      if (property === "core") return core;
      if (property === "onPlayerLogin") return (handler) => loginHooks.push(handler);
      if (property === "onPlayerDeath") return (handler) => deathHooks.push(handler);
      return () => undefined;
    },
  });
  const quiet = console.log;
  console.log = () => {};
  try {
    require("../plugins/quests/Quests.plugin.js").register(api);
  } finally {
    console.log = quiet;
  }
});

function playerSendingTo(sent, bot) {
  const sender = new Proxy({}, { get: (_, key) => (...args) => { sent.push(key); return sender; } });
  const attributes = new Map();
  return {
    isPlayerBot: () => bot,
    getPacketSender: () => sender,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getUsername: () => (bot ? "DevBot1" : "Admin"),
    sendMessage: () => {},
  };
}

function login(player) {
  for (const hook of loginHooks) {
    try { hook({ player, username: player.getUsername(), isNewAccount: false }); } catch {}
  }
}

function die(player) {
  for (const hook of deathHooks) {
    try { hook({ player, killer: null, itemsLost: true, handled: false }); } catch {}
  }
}

// Records every property the quest hooks read off the player.
function recordingPlayer(bot) {
  const reads = [];
  const player = new Proxy({}, {
    get: (_, key) => {
      reads.push(String(key));
      if (key === "isPlayerBot") return () => bot;
      if (key === "getUsername") return () => (bot ? "DevBot1" : "Admin");
      if (key === "getPacketSender") return () => new Proxy({}, { get: () => () => undefined });
      return () => undefined;
    },
  });
  return { player, reads };
}

test("a bot's login runs none of the quests' login hooks", () => {
  assert.ok(loginHooks.length > 100, `the quests register their login hooks (${loginHooks.length})`);
  const sent = [];
  login(playerSendingTo(sent, true));
  assert.equal(sent.length, 0, "nothing sent for a bot");
});

test("a real player's login still sends the quest progress", () => {
  const sent = [];
  login(playerSendingTo(sent, false));
  assert.ok(sent.filter((key) => key === "sendConfig" || key === "sendVarbit").length > 50, "quest varps and varbits sent");
});

test("a bot's death runs none of the quests' death hooks", () => {
  assert.ok(deathHooks.length > 10, `the quests register their death hooks (${deathHooks.length})`);
  const { player, reads } = recordingPlayer(true);
  die(player);
  assert.deepEqual(reads.filter((key) => key !== "isPlayerBot"), [], "no quest death handler touched a bot");
});

test("a real player's death still runs the quests' death hooks", () => {
  const { player, reads } = recordingPlayer(false);
  die(player);
  assert.ok(reads.includes("getAttribute"), "the quest death handlers read the dying player's stage");
});
