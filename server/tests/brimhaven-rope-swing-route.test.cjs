// Run after `yarn build`: node --test tests/brimhaven-rope-swing-route.test.cjs
// A rope swing click through the real packet, routing and walk-to path, on cache clipping.
const assert = require("node:assert/strict");
const { before, test } = require("node:test");
const path = require("node:path");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { ObjectActionPacketListener } = require("../dist/net/packet/impl/ObjectActionPacketListener");
const core = PluginManager.getCoreApi();

before(async () => {
  await require("../dist/game/cache/CachePipeline").CachePipeline.initialize(path.resolve(__dirname, ".."));
  core.RegionManager.init();
});

test("a rope swing clicked from the platform corner walks to the rope's axis and swings", () => {
  for (const key of ["objectInteractionHooks", "objectRouteHooks"]) PluginManager[key] = [];
  for (const key of ["objectHooksByName", "objectHooksById", "customEventHooks"]) PluginManager[key] = new Map();
  const api = PluginManager.createApi("brimhaven-rope-swing-route");
  require("../plugins/minigames/brimhavenagilityarena/Shared.BrimhavenAgilityArena").init(api);
  require("../plugins/minigames/brimhavenagilityarena/Obstacles.BrimhavenAgilityArena")(api);

  const player = new Player(null);
  player.setUsername("offline1447");
  player.setIndex(1447);
  player.isRegistered = () => true;
  let sender;
  sender = new Proxy({}, { get: (target, key) => target[key] ?? (() => sender) });
  player.getPacketSender = () => sender;
  player.sendMessage = () => {};
  core.RegionManager.loadMapFiles(2806, 9585, false);
  player.setLocation(new core.Location(2804, 9587, 3));
  player.setNeedsPlacement(false);

  const seen = [];
  new ObjectActionPacketListener().executeAction(player, 3566, 2806, 9585, 1, "Swing-on");
  for (let n = 0; n < 30; n++) {
    core.World.processCycle = (core.World.processCycle + 1) & 0x7fffffff;
    core.TaskManager.process(); player.getMovementQueue().beginCycle();
    player.getMovementQueue().process(); core.TaskManager.processWalkTo(player.getIndex());
    const at = player.getLocation();
    seen.push(`${at.getX()},${at.getY()}`);
  }
  assert.ok(seen.includes("2806,9587"), `walks to two tiles before the rope: ${seen.join(" ")}`);
  const at = player.getLocation();
  assert.deepEqual([at.getX(), at.getY(), at.getZ()], [2806, 9582, 3], "lands three tiles past the rope");
});
