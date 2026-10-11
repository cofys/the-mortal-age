// Run after `yarn build`: node --test tests/runecrafting-exit-portals.test.cjs
// An altar's exit portal leads back outside its ruins, as rsprox captures show (docs/loc-teleports.md).
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");

const handlers = {};

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const base = {
    core: PluginManager.getCoreApi(),
    onObjectInteraction: (name, actions) => Object.entries(actions).forEach(([option, handler]) => (handlers[`${name}:${option}`] = handler)),
    onNpcInteraction: (name, actions) => Object.entries(actions).forEach(([option, handler]) => (handlers[`${name}:${option}`] = handler)),
    // The mine portal's teleport comes a tick later; here it runs at once.
    getTaskManager: () => ({ submit: (task) => task.execute() }),
  };
  const api = new Proxy(base, { get: (target, key) => (key in target ? target[key] : () => {}) });
  require("../plugins/skills/Runecrafting.plugin").register(api);
});

function visitor() {
  const log = [];
  return {
    log,
    moveTo: (location) => log.push(`move ${location.getX()},${location.getY()},${location.getZ()}`),
    sendMessage: (text) => log.push(`message ${text}`),
    getPacketSender: () => ({ sendSound: (id) => log.push(`sound ${id}`) }),
  };
}

test("each altar's exit portal leads outside its ruins, with the portal's sound and message", () => {
  // Captured: earth, fire, water, nature and cosmic; the rest from the ruins' tiles.
  const exits = { 34751: [3302, 3477], 34752: [3310, 3252], 34750: [3182, 3162], 34756: [2865, 3022], 34754: [2405, 4381],
    34748: [2983, 3288], 34749: [2980, 3511], 34753: [3050, 3442], 34755: [2858, 3378], 34757: [3060, 3585], 34758: [1863, 4639] };
  for (const [objectId, [x, y]] of Object.entries(exits)) {
    const player = visitor();
    assert.equal(handlers["Portal:Use"]({ player, objectId: Number(objectId) }), true);
    assert.deepEqual(player.log, [`move ${x},${y},0`, "sound 200", "message You step through the portal..."], objectId);
  }
  assert.equal(handlers["Portal:Use"]({ player: visitor(), objectId: 12345 }), false, "other portals fall through");
});

function miner({ x = 2889, y = 4814, attributes = {} } = {}) {
  const log = [];
  const attrs = new Map(Object.entries(attributes));
  const { Location } = PluginManager.getCoreApi();
  return {
    log,
    getAttribute: (key) => attrs.get(key),
    setAttribute: (key, value) => attrs.set(key, value),
    getLocation: () => new Location(x, y, 0),
    getMovementQueue: () => ({ reset() {} }),
    moveTo: (location) => log.push(`move ${location.getX()},${location.getY()},${location.getZ()}`),
    sendMessage: (text) => log.push(`message ${text}`),
    performGraphic: (graphic) => log.push(`graphic ${graphic.getId()}`),
    getPacketSender: () => ({
      sendSound: (id) => log.push(`sound ${id}`),
      sendProjectile: (_from, _to, _offset, _speed, id) => log.push(`projectile ${id}`),
    }),
  };
}

test("the Rune Essence mine's portals send the player back to the wizard who sent them", () => {
  // Aubury's Teleport records where the player stood (Rune Mysteries complete).
  const visitor = miner({ x: 3253, y: 3402, attributes: { "quest.rune_mysteries.stage": 6 } });
  assert.equal(handlers["Aubury:Teleport"]({ player: visitor }), true);
  assert.deepEqual(visitor.getAttribute("runecrafting:essence-mine-return"), [3253, 3402, 0]);

  const player = miner({ attributes: { "runecrafting:essence-mine-return": [2591, 3086, 0] } });
  assert.equal(handlers["Portal:Use"]({ player, objectId: 34825, location: { x: 2889, y: 4813, z: 0 } }), true);
  assert.deepEqual(player.log, [
    "message You step through the portal...", "projectile 109", "graphic 110", "move 2591,3086,0", "sound 200",
  ], "as captured: message and the portal's Curse, then the teleport and sound");

  const unknown = miner();
  handlers["Portal:Use"]({ player: unknown, objectId: 34825, location: { x: 2933, y: 4815, z: 0 } });
  assert.ok(unknown.log.includes("move 3252,3400,0"), "nobody recorded: back beside Aubury");
});
