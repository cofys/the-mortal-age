const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const {
  PlayerSave,
} = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const Common = require("../plugins/items/diaryrewards/Common.DiaryRewards");
let core,
  next = 300;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PluginManager.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PluginManager.getCoreApi();
});
function actor(t) {
  const channel = {
    kind: "test",
    remoteAddress: "127.0.0.1",
    isOpen: () => true,
    send: () => true,
    close() {},
    onData() {},
    onError() {},
    onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("ringqa" + p.getIndex());
  p.setRegistered(true);
  p.needsPlacement = false;
  const messages = [];
  t.mock.method(p.getPacketSender(), "sendMessage", (s) => {
    messages.push(s);
    return p.getPacketSender();
  });
  t.after(() => {
    PluginManager.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
  });
  return { p, messages };
}
function login(f) {
  PluginManager.emitPlayerLogin({
    player: f.p,
    username: f.p.getUsername(),
    isNewAccount: true,
  });
}
function use(f, name = "lumbridge_ring_easy", option = "Energy") {
  const id = core.CacheDefinitions.getObjId(name);
  let item = f.p
    .getInventory()
    .getItems()
    .find((x) => x.getId() === id);
  if (!item) {
    f.p.getInventory().add(new core.Item(id), false);
    item = f.p
      .getInventory()
      .getItems()
      .find((x) => x.getId() === id);
  }
  const slot = f.p.getInventory().getItems().indexOf(item),
    definition = core.CacheDefinitions.getItem(id);
  let action = option,
    subOpId,
    clickType = definition.inventoryActions.indexOf(option) + 1;
  if (clickType === 0) {
    action = "Functions";
    clickType = definition.inventoryActions.indexOf(action) + 1;
    subOpId = definition.subops[clickType - 1].indexOf(option) + 1;
  }
  assert.ok(clickType > 0);
  assert.equal(
    PluginManager.emitItemAction({
      player: f.p,
      item,
      itemId: id,
      slot,
      interfaceId: core.CacheDefinitions.getComponentId("inventory:items"),
      option: action,
      clickType,
      subOpId,
      handled: false,
    }),
    true,
  );
}
function energy(f, n = 1) {
  for (let i = 0; i < n; i++) {
    f.p.setRunEnergy(0);
    use(f);
  }
}
function clock(t) {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-26T23:59:00Z"),
  });
}
function count(f, name = "lumbridge_energy_restore") {
  return f.p
    .getPacketSender()
    .getVarbit(core.CacheDefinitions.getVarbitId(name));
}

test("staying online past midnight does not replenish Explorer’s ring energy", (t) => {
  clock(t);
  const f = actor(t);
  login(f);
  energy(f, 2);
  assert.equal(count(f), 2);
  t.mock.timers.tick(120000);
  energy(f);
  assert.equal(f.p.getRunEnergy(), 0);
  assert.equal(count(f), 2);
  assert.match(f.messages.at(-1), /used all/);
});
test("another diary allowance cannot reset the ring while it stays online", (t) => {
  clock(t);
  const f = actor(t);
  login(f);
  energy(f, 2);
  t.mock.timers.tick(120000);
  Common.useDaily(f.p, "falador-shield");
  energy(f);
  assert.equal(f.p.getRunEnergy(), 0);
  assert.match(f.messages.at(-1), /used all/);
});
test("next-day relog replenishes once and sends the zero counter, same-day relog preserves uses", (t) => {
  clock(t);
  const f = actor(t);
  login(f);
  energy(f, 2);
  login(f);
  assert.equal(count(f), 2);
  t.mock.timers.tick(120000);
  login(f);
  assert.equal(count(f), 0);
  energy(f);
  assert.equal(f.p.getRunEnergy(), 50);
  assert.equal(count(f), 1);
  login(f);
  assert.equal(count(f), 1);
});
test("legacy daily counts migrate without refunding spent energy or alchemy", (t) => {
  clock(t);
  const f = actor(t);
  f.p.setAttribute(Common.DAILY_ATTRIBUTE, {
    day: "2026-10-26",
    counts: { "explorers-ring-energy": 2, "explorers-ring-alchemy": 17 },
  });
  login(f);
  energy(f);
  assert.equal(f.p.getRunEnergy(), 0);
  use(f, "lumbridge_ring_easy", "Check");
  assert.match(f.messages.at(-1), /13 out of 30 alchemy charges left/);
  assert.equal(count(f, "lumbridge_free_alchs"), 17);
});
test("an upgraded ring shares its allowance and real saves retain same-day uses", async (t) => {
  clock(t);
  const f = actor(t);
  login(f);
  energy(f, 2);
  f.p.setRunEnergy(0);
  use(f, "lumbridge_ring_elite", "Energy");
  assert.equal(f.p.getRunEnergy(), 100);
  assert.equal(count(f), 3);
  const saved = PlayerSave.fromPlayer(f.p),
    g = actor(t);
  saved.applyToPlayer(g.p);
  login(g);
  assert.equal(count(g), 3);
  g.p.setRunEnergy(0);
  use(g, "lumbridge_ring_elite", "Energy");
  assert.equal(g.p.getRunEnergy(), 0);
  assert.match(g.messages.at(-1), /used all/);
});

test("four uses on ring3 remain spent after upgrading to ring4", (t) => {
  clock(t);
  const f = actor(t);
  login(f);
  for (let i = 0; i < 4; i++) {
    f.p.setRunEnergy(0);
    use(f, "lumbridge_ring_hard", "Energy");
  }
  assert.equal(count(f), 4);
  f.p.setRunEnergy(0);
  use(f, "lumbridge_ring_elite", "Energy");
  assert.equal(f.p.getRunEnergy(), 0);
  assert.match(f.messages.at(-1), /used all/);
});

test("spellbook refresh preserves the real ring alchemy counter", (t) => {
  clock(t);
  const f = actor(t);
  f.p.setAttribute(Common.DAILY_ATTRIBUTE, {
    day: "2026-10-26",
    counts: { "explorers-ring-alchemy": 17 },
  });
  login(f);
  for (const book of [1151, 12855, 29999, 39999]) {
    f.p.getPacketSender().sendTabInterface(6, book);
    assert.equal(count(f, "lumbridge_free_alchs"), 17);
  }
  t.mock.timers.tick(120000);
  login(f);
  assert.equal(count(f, "lumbridge_free_alchs"), 0);
  assert.equal(count(f), 0);
});
