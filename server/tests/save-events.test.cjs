const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PlayerPersistence } = require("../dist/game/entity/impl/player/persistence/PlayerPersistence");
const { PlayerPunishment } = require("../dist/util/PlayerPunishment");

function setup() {
  const writes = [];
  class Persistence extends PlayerPersistence {
    load() { return null; }
    exists() { return false; }
    save(player, reason) { writes.push({ amount: player.amount, reason }); }
  }
  const persistence = new Persistence();
  const handlers = new Map();
  const emit = (name, event) => handlers.get(name)?.(event);
  require("../plugins/persistence/SaveEvents.plugin").register({
    core: {
      GameConstants: { PLAYER_PERSISTENCE: persistence },
      Item: class { constructor(id, amount) { return item({ id, amount }); } },
    },
    onCustomEvent: (name, handler) => handlers.set(name, handler),
    emitCustomEvent: emit,
  });
  handlers.set("collection-log:is-item", event => { event.logged = event.itemId === 2; });
  const player = { amount: 0, getUsername: () => "Test", getAttribute: () => false };
  return { persistence, writes, emit, player };
}

function item({ value = 1, tradeable = true, dropable = true, id = 1, amount = 1 } = {}) {
  return {
    getDefinition: () => ({ unNote: () => id, isNoted: () => false, getGrandExchangeValue: () => value }),
    getAmount: () => amount,
    isTradeable: () => tradeable,
    isDropable: () => dropable,
  };
}

test("quest, diary and shop triggers snapshot the completed operation once", async () => {
  const { persistence, writes, emit, player } = setup();
  emit("quest:completed", { player });
  player.amount = 50;
  emit("persistence:save", { player, reason: "diary-tier-reward" });
  emit("shop:purchase", { player, currency: "POINTS" });
  player.amount = 75;
  assert.deepEqual(writes, []);
  await persistence.flush();
  assert.deepEqual(writes, [{ amount: 75, reason: "quest-completion,diary-tier-reward,reward-shop" }]);
});

test("ordinary coin purchases and cheap drops do not create save traffic", async () => {
  const { persistence, writes, emit, player } = setup();
  emit("shop:purchase", { player, currency: "COINS" });
  emit("item:discarded", { player, item: item({ value: 9_999_999 }) });
  await persistence.flush();
  assert.deepEqual(writes, []);
});

test("10m stack value, untradeable, restricted and collection items trigger saving", async () => {
  for (const discarded of [item({ value: 5_000_000, amount: 2 }), item({ tradeable: false }),
    item({ dropable: false }), item({ id: 2 })]) {
    const { persistence, writes, emit, player } = setup();
    emit("item:discarded", { player, item: discarded });
    await persistence.flush();
    assert.equal(writes[0].reason, "valuable-item-discard");
  }
});

test("players flagged to skip persistence are never queued", async () => {
  const { persistence, writes, emit, player } = setup();
  player.getAttribute = () => true;
  emit("persistence:save", { player, reason: "respawn" });
  await persistence.flush();
  assert.deepEqual(writes, []);
});

test("loot saves read the final roll after other plugins remove or replace drops", async () => {
  const { persistence, writes, emit, player } = setup();
  const event = { player, drops: [{ itemId: 2, amount: 1 }] };
  emit("npc-drops:roll", event);
  event.drops.length = 0;
  await new Promise(resolve => queueMicrotask(resolve));
  await persistence.flush();
  assert.deepEqual(writes, []);
  event.drops.push({ itemId: 2, amount: 1 });
  emit("npc-drops:roll", event);
  await new Promise(resolve => queueMicrotask(resolve));
  await persistence.flush();
  assert.equal(writes[0].reason, "rare-drop");
});

test("punishment file writes are asynchronous and retain update order", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsps-punishments-"));
  const file = path.join(directory, "Bans.txt");
  PlayerPunishment.addToFile(file, "Alice");
  assert.equal(fs.existsSync(file), false);
  PlayerPunishment.addToFile(file, "Bob");
  PlayerPunishment.deleteFromFile(file, "Alice");
  await PlayerPunishment.flush();
  assert.equal(fs.readFileSync(file, "utf8"), "Bob\n");
});

test("shutdown is cancelled if snapshots or asynchronous writes fail", async () => {
  const { GameConstants } = require("../dist/game/GameConstants");
  const { World } = require("../dist/game/World");
  const { PluginManager } = require("../dist/plugins/PluginManager");
  const previous = {
    backend: GameConstants.PLAYER_PERSISTENCE, save: World.savePlayers,
    hooks: PluginManager.emitServerShutdown, exit: process.exit, kill: process.kill,
  };
  let exited = false;
  process.exit = () => { exited = true; };
  process.kill = () => { exited = true; };
  PluginManager.emitServerShutdown = () => {};
  try {
    for (const diskFailure of [true, false]) {
      GameConstants.PLAYER_PERSISTENCE = { flush: async () => {
        if (diskFailure) throw new Error("test write failure");
      } };
      World.savePlayers = () => ({ saved: 0, failed: diskFailure ? 0 : 1 });
      await Server.gracefulShutdown("unit-test", "restart");
      assert.equal(exited, false);
      assert.equal(Server.shuttingDown, false, "shutdown can be retried after recovery");
    }
  } finally {
    GameConstants.PLAYER_PERSISTENCE = previous.backend;
    World.savePlayers = previous.save;
    PluginManager.emitServerShutdown = previous.hooks;
    process.exit = previous.exit;
    process.kill = previous.kill;
  }
});
