// Run after `yarn build`: node --test tests/quests-bot-login.test.cjs
// The quests' login and death hooks skip bots (plugins/quests/Quests.plugin.js forPlayers): a bot
// has no client for quest progress and does no quests, and running ~160 login hooks made each bot
// login cost ~85 ms; bot deaths were worse per event (one quest scans every world NPC).
const assert = require("node:assert/strict");
const { before, test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const questsPlugin = require("../plugins/quests/Quests.plugin.js");

const loginHooks = [];
const deathHooks = [];
const questLabels = [];

before(async () => {
  await require("../dist/game/cache/CachePipeline").CachePipeline.initialize(require("node:path").resolve(__dirname, ".."));
  const core = PluginManager.getCoreApi();
  // Retain real profiling for login/death; other registrations are outside these tests.
  const recordingApi = (api) => new Proxy(api, {
    get: (target, property) => {
      if (property === "core") return core;
      if (property === "withProfileLabel") return (label) => {
        questLabels.push(label);
        return recordingApi(target.withProfileLabel(label));
      };
      if (property === "onPlayerLogin") return (handler) => {
        loginHooks.push(handler);
        return target.onPlayerLogin(handler);
      };
      if (property === "onPlayerDeath") return (handler) => {
        deathHooks.push(handler);
        return target.onPlayerDeath(handler);
      };
      return () => undefined;
    },
  });
  const quiet = console.log;
  console.log = () => {};
  try {
    questsPlugin.register(recordingApi(PluginManager.createApi("Quests")));
  } finally {
    console.log = quiet;
  }
});

test("quests receive separate profiling labels in their registration order", () => {
  assert.deepEqual(questLabels, questsPlugin.QUESTS.map((quest) => `Quests/${quest}`));
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

test("quest profiling keeps separate stats and original callback names while skipping bots", () => {
  const enabled = PluginManager.isPluginPerformanceProfilingEnabled();
  PluginManager.resetPluginPerformanceStats();
  PluginManager.setPluginPerformanceProfilingEnabled(true);
  try {
    const { player, reads } = recordingPlayer(true);
    PluginManager.emitPlayerLogin({ player, username: "DevBot1", isNewAccount: false });
    const rows = PluginManager.getPluginPerformanceSnapshot(questsPlugin.QUESTS.length + 1);
    assert.ok(rows.length > 100, "each quest's login is timed separately");
    const shared = rows.find((row) => row.pluginName === "Quests");
    assert.ok(shared, "shared quest-list hooks retain the parent bucket");
    assert.equal(shared.calls, 3, "shared login hooks register once");
    for (const [quest, handler] of [["RecipeForDisaster", "syncQuestState"], ["CooksAssistant", "handleLogin"], ["DragonSlayer", "syncState"]]) {
      const row = rows.find((entry) => entry.pluginName === `Quests/${quest}`);
      assert.ok(row, `${quest} has its own stats`);
      assert.equal(row.calls, 1);
      assert.equal(row.errors, 0);
      assert.equal(row.maxEventName, "player_login");
      assert.equal(row.maxHandlerName, handler);
    }
    assert.deepEqual(reads.filter((key) => key !== "isPlayerBot"), [], "profiled login still skips bot quest work");

    PluginManager.resetPluginPerformanceStats();
    PluginManager.emitPlayerDeath({ player, killer: null, itemsLost: true, handled: false });
    const horror = PluginManager.getPluginPerformanceSnapshot(questsPlugin.QUESTS.length)
      .find((entry) => entry.pluginName === "Quests/HorrorFromTheDeep");
    assert.ok(horror, "Horror from the Deep has its own death stats");
    assert.equal(horror.maxEventName, "player_death");
    assert.equal(horror.maxHandlerName, "handlePlayerDeath");
    assert.deepEqual(reads.filter((key) => key !== "isPlayerBot"), [], "profiled death still skips bot quest work");
  } finally {
    PluginManager.setPluginPerformanceProfilingEnabled(enabled);
    PluginManager.resetPluginPerformanceStats();
  }
});
