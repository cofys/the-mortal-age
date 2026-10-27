const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
let core, next = 1300;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins")); core = PM.getCoreApi();
  core.RegionManager.init(); core.RegionManager.loadMapFiles(3222, 3218); PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername("petstate" + next); p.setRegistered(true);
  p.setLocation(new core.Location(3222, 3218, 0)); p.needsPlacement = false;
  const c = new ClientConnection(channel); c.player = p;
  const messages = []; t.mock.method(p.getPacketSender(), "sendMessage", m => { messages.push(m); return p.getPacketSender(); });
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    if (core.World.getPlayers().get(p.getIndex()) === p) core.World.getPlayers().remove(p);
    p.setRegistered(false); core.TaskManager.cancelTasks(p.getIndex());
    for (const n of [...core.World.getNpcs()]) if (n?.getOwner?.() === p) core.World.getNpcs().remove(n);
  });
  return { p, c, messages };
}
function pet(f, id = core.ItemIdentifiers.OLMLET) {
  PM.emitCustomEvent("npc-drops:roll", { player: f.p, drops: [{ itemId: id, amount: 1 }] });
  const n = f.p.getAttribute("pets:current"); assert.ok(n?.isRegistered()); return n;
}
function restored(t, save) {
  const f = actor(t); save.applyToPlayer(f.p); PM.emitPlayerLogin({ player: f.p, username: f.p.getUsername(), isNewAccount: false }); f.p.needsPlacement = false; return f;
}
function assertFollower(f, id = core.CacheDefinitions.getNpcId("raids_olm_pet")) {
  const n = f.p.getAttribute("pets:current"); assert.ok(n?.isRegistered()); assert.equal(n.getId(), id); assert.equal(n.getOwner(), f.p);
  assert.equal([...core.World.getNpcs()].filter(n => n?.getOwner?.() === f.p && n?.isPet?.()).length, 1);
}
async function pickup(f, n) {
  n.setLocation(new core.Location(3221, 3218, 0));
  const clickType = n.getCurrentDefinition(f.p).getActions().findIndex(a => a?.toLowerCase() === "pick-up") + 1;
  assert.ok(clickType > 0);
  await f.c.dispatch([{ type: "npc_option", index: n.getIndex(), clickType }]); f.c.processTurnPackets();
  for (let i = 0; i < 8; i++) { core.TaskManager.processWalkTo(f.p.getIndex()); f.p.getMovementQueue().process(); core.TaskManager.process(); }
}
test("an active-follower autosave is self-contained without a temporary inventory item", t => {
  const f = actor(t); pet(f); const save = PlayerSave.fromPlayer(f.p), g = restored(t, save);
  assertFollower(g); assert.equal(g.p.getInventory().getAmount(core.ItemIdentifiers.OLMLET), 0);
});
test("a snapshot with an active main-drop pet preserves its separate duplicate inventory item", t => {
  const f = actor(t), id = core.ItemIdentifiers.ABYSSAL_ORPHAN; const n = pet(f, id); pet(f, id);
  assert.equal(f.p.getInventory().getAmount(id), 1); const g = restored(t, PlayerSave.fromPlayer(f.p));
  assertFollower(g, n.getId()); assert.equal(g.p.getInventory().getAmount(id), 1);
});
test("full inventory and a genuinely full bank cannot prevent restoring the active follower", t => {
  const f = actor(t); pet(f); const inv = f.p.getInventory(), bank = f.p.getBank(0);
  while (inv.getFreeSlots()) inv.add(new core.Item(core.ItemIdentifiers.RAKE), false);
  for (let id = 1; bank.getFreeSlots() > 0 && id < 20000; id++) {
    const def = core.ItemDefinition.forId(id); if (!def || def.isNoted() || !def.getName() || def.getName() === "null") continue;
    bank.add(new core.Item(id), false);
  }
  assert.equal(bank.getFreeSlots(), 0); const held = bank.getItems().filter(x => x?.getId() >= 0).map(x => [x.getId(), x.getAmount()]);
  const g = restored(t, PlayerSave.fromPlayer(f.p)); assertFollower(g);
  assert.equal(g.p.getInventory().getFreeSlots(), 0); assert.deepEqual(g.p.getBank(0).getItems().filter(x => x?.getId() >= 0).map(x => [x.getId(), x.getAmount()]), held);
});
test("native pickup clears the active descriptor and a later login leaves the item held", async t => {
  const f = actor(t), n = pet(f); await pickup(f, n); assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.OLMLET), 1, JSON.stringify(f.messages));
  const g = restored(t, PlayerSave.fromPlayer(f.p)); assert.ok(!g.p.getAttribute("pets:current")); assert.equal(g.p.getInventory().getAmount(core.ItemIdentifiers.OLMLET), 1);
});
test("explicit logout preserves the active descriptor without changing inventory contents", t => {
  const f = actor(t); pet(f); PM.emitPlayerLogout({ player: f.p, username: f.p.getUsername() });
  assert.equal(f.p.getInventory().getAmount(core.ItemIdentifiers.OLMLET), 0); const g = restored(t, PlayerSave.fromPlayer(f.p)); assertFollower(g);
  PM.emitPlayerLogin({ player: g.p, username: g.p.getUsername(), isNewAccount: false }); assertFollower(g);
});
test("legacy last-pet plus physical item migrates once to the new active descriptor", t => {
  const f = actor(t), id = core.ItemIdentifiers.OLMLET; f.p.getInventory().add(new core.Item(id), false); f.p.setAttribute("pets:last", id); f.p.setAttribute("pets.owned", [id]);
  const g = restored(t, PlayerSave.fromPlayer(f.p)); assertFollower(g); assert.equal(g.p.getInventory().getAmount(id), 0);
  assert.equal(g.p.getAttribute("pets:active-item"), id);
});
test("release clears active persistence without turning ownership into an automatic reclaim", t => {
  const f = actor(t), n = pet(f), request = { player: f.p, npc: n, released: false }; PM.emitCustomEvent("pets:release", request); assert.equal(request.released, true);
  const g = restored(t, PlayerSave.fromPlayer(f.p)); assert.ok(!g.p.getAttribute("pets:current")); assert.deepEqual(g.p.getAttribute("pets.owned"), [core.ItemIdentifiers.OLMLET]);
});
test("actual shutdown hooks followed by the player snapshot preserve a world-registered follower", t => {
  const f = actor(t); f.p.setRegistered(false); assert.equal(core.World.getPlayers().add(f.p), true); f.p.needsPlacement = false; pet(f);
  PM.emitServerShutdown({ timestamp: Date.now() }); const g = restored(t, PlayerSave.fromPlayer(f.p)); assertFollower(g);
});
