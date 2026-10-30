const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { ItemActionPacketListener: Actions } = require('../dist/net/packet/impl/ItemActionPacketListener');
let core;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core.RegionManager.loadMapFiles(3222, 3218);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));
const id = name => core.CacheDefinitions.getObjId(name);
function fixture(amount = 1, name = 'port_task_lootsack_t0_port_sarim') {
  const p = new Player(null);
  p.setUsername('rewardbagqa');
  p.getSession = () => ({ sendClientPacket: () => true });
  const messages = [];
  p.sendMessage = message => messages.push(message);
  p.getInventory().setItem(0, new core.Item(id(name), amount));
  return { p, inv: p.getInventory(), messages, bag: id(name) };
}
function open(p, slot = 0) {
  return Actions.handleAction(p, core.Inventory.INTERFACE_ID, p.getInventory().getItems()[slot].getId(), slot, 1, 'Open');
}
function random(values, run) {
  const original = Math.random;
  let n = 0;
  Math.random = () => values[Math.min(n++, values.length - 1)];
  try { return run(); } finally { Math.random = original; }
}
test('native Open consumes one reward bag for one shared loot drop', () => {
  const { p, inv, bag } = fixture(2);
  random([0, 0], () => open(p));
  assert.equal(inv.getAmount(bag), 1);
  assert.equal(inv.getAmount(id('coins')), 5000);
});
test('destination roll opens Port Sarim bag for its noted casket', () => {
  const { p, inv, bag } = fixture();
  random([0.999999, 0, 0], () => open(p));
  assert.equal(inv.getAmount(bag), 0);
  assert.equal(inv.getAmount(id('cert_casket')), 1);
});
test('a last bag frees its own slot in a full real inventory', () => {
  const { p, inv, bag } = fixture();
  for (let slot = 1; slot < 28; slot++) inv.setItem(slot, new core.Item(id('knife')));
  assert.equal(inv.getFreeSlots(), 0);
  random([0, 0], () => open(p));
  assert.equal(inv.getAmount(bag), 0);
  assert.equal(inv.getAmount(id('coins')), 5000);
  assert.equal(inv.getAmount(id('knife')), 27);
});

test('a remaining bag stack cannot free a slot; a retry retains the rolled drop', () => {
  const { p, inv, bag, messages } = fixture(2);
  for (let slot = 1; slot < 28; slot++) inv.setItem(slot, new core.Item(id('knife')));
  random([0, 0], () => open(p));
  assert.equal(inv.getAmount(bag), 2);
  assert.equal(inv.getAmount(id('coins')), 0);
  assert.ok(messages.includes('Not enough space in your inventory.'));
  inv.deleteAtSlot(1, 1, false);
  random([0.999999], () => open(p));
  assert.equal(inv.getAmount(bag), 1);
  assert.equal(inv.getAmount(id('coins')), 5000, 'capacity retry cannot reroll into a casket');
});

test('the integer stack cap refuses partial loot and preserves the exact input', () => {
  const { MAX_STACK_AMOUNT } = require('../dist/game/model/container/StackType');
  const { p, inv, bag } = fixture();
  inv.setItem(1, new core.Item(id('coins'), MAX_STACK_AMOUNT - 4999));
  const held = inv.getItems()[0];
  random([0, 0], () => open(p));
  assert.equal(inv.getItems()[0], held);
  assert.equal(inv.getAmount(bag), 1);
  assert.equal(inv.getAmount(id('coins')), MAX_STACK_AMOUNT - 4999);
  inv.deleteAtSlot(1, 1, false);
  random([0.999999], () => open(p));
  assert.equal(inv.getAmount(id('coins')), MAX_STACK_AMOUNT);
  assert.equal(inv.getAmount(bag), 0);
});

test('native packet widget UID reaches Open and only the clicked metadata stack is consumed', () => {
  const { ClientConnection } = require('../dist/net/NetworkBuilder');
  const { p, inv, bag } = fixture(2);
  inv.setItem(1, new core.Item(bag, 3, { fixture: ['preserved'] }));
  const first = inv.getItems()[0], clicked = inv.getItems()[1];
  random([0, 0], () => ClientConnection.prototype.inventoryAction.call({ player: p }, {
    type: 'inventory_action', widgetId: core.CacheDefinitions.getComponentId('inventory:items'),
    itemId: bag, slot: 1, optionIndex: 1, option: 'Open',
  }));
  assert.equal(inv.getItems()[0], first);
  assert.equal(first.getAmount(), 2);
  assert.equal(inv.getItems()[1], clicked);
  assert.equal(clicked.getAmount(), 2);
  assert.deepEqual(clicked.getMeta(), { fixture: ['preserved'] });
  assert.equal(inv.getAmount(id('coins')), 5000);
});

test('a reward does not merge with a different metadata stack', () => {
  const { p, inv } = fixture(2);
  inv.setItem(1, new core.Item(id('coins'), 123, { preset: true }));
  random([0, 0], () => open(p));
  assert.equal(inv.getItems()[1].getAmount(), 123);
  assert.deepEqual(inv.getItems()[1].getMeta(), { preset: true });
  assert.equal(inv.getItems()[2].getId(), id('coins'));
  assert.equal(inv.getItems()[2].getAmount(), 5000);
  assert.equal(inv.getItems()[2].getMeta(), null);
});

test('double clicks consume at most the bags actually held', () => {
  const { p, inv, bag } = fixture(2);
  random([0, 0], () => { open(p); open(p); Actions.handleAction(p, core.Inventory.INTERFACE_ID, bag, 0, 1, 'Open'); });
  assert.equal(inv.getAmount(bag), 0);
  assert.equal(inv.getAmount(id('coins')), 10000);
});

test('dead, trading, teleporting, wrong-source and stale events cannot open a bag', () => {
  const { PlayerStatus } = require('../dist/game/model/PlayerStatus');
  for (const setup of [p => p.setHitpoints(0), p => p.setStatus(PlayerStatus.TRADING), p => p.setNeedsPlacement(true)]) {
    const { p, inv, bag } = fixture();
    setup(p);
    open(p);
    assert.equal(inv.getAmount(bag), 1);
    assert.equal(inv.getAmount(id('coins')), 0);
  }
  const { p, inv, bag } = fixture();
  for (const event of [
    { interfaceId: core.Inventory.INTERFACE_ID, item: new core.Item(bag) },
    { interfaceId: core.Equipment.INVENTORY_INTERFACE_ID, item: inv.getItems()[0] },
  ]) PM.emitItemAction({ player: p, itemId: bag, slot: 0, clickType: 1, option: 'Open', handled: false, ...event });
  assert.equal(inv.getAmount(bag), 1);
});

test('pending loot and inventory survive actual save codec hydration and a real bank transfer', () => {
  const { PlayerSave } = require('../dist/game/entity/impl/player/persistence/PlayerSave');
  const Json = require('../plugins/persistence/JsonPlayerPersistence.plugin');
  const { PENDING_ATTRIBUTE } = require('../plugins/skills/sailing/porttasks/Bags.PortTasks');
  const { p, inv, bag } = fixture(2);
  for (let slot = 1; slot < 28; slot++) inv.setItem(slot, new core.Item(id('knife')));
  random([0, 0], () => open(p));
  const codec = new Json.JsonPlayerPersistence();
  const saved = JSON.parse(JSON.stringify(PlayerSave.fromPlayer(p), codec.replacer.bind(codec)), codec.reviver.bind(codec));
  const restored = fixture().p;
  codec.hydratePlayerSave(saved).applyToPlayer(restored);
  assert.deepEqual(restored.getAttribute(PENDING_ATTRIBUTE), { [bag]: { item: 'coins', amount: 5000 } });
  const ri = restored.getInventory();
  restored.getBank(0).open();
  core.Bank.deposit(restored, bag, 0, 2, false);
  assert.equal(ri.getAmount(bag), 0);
  ri.deleteAtSlot(1, 1, false);
  core.Bank.withdraw(restored, bag, restored.getBank(0).getSlotForItemId(bag), 2, 0);
  restored.getPacketSender().sendInterfaceRemoval();
  random([0.999999], () => open(restored, ri.getSlotForItemId(bag)));
  assert.equal(ri.getAmount(bag), 1);
  assert.equal(ri.getAmount(id('coins')), 5000);
  assert.deepEqual(restored.getAttribute(PENDING_ATTRIBUTE), {});
});

test('all 95 obtainable bags and every Wiki loot row resolve against the active cache', () => {
  const Loot = require('../plugins/skills/sailing/porttasks/Loot.PortTasks');
  const tasks = require('../plugins/skills/sailing/data/port-tasks.json');
  assert.deepEqual(Loot.DATA.tiers.map(t => t.localWeight / t.totalWeight), [1 / 96, 1 / 84, 1 / 80, 2 / 155, 1 / 75]);
  let supported = 0;
  for (let size = 0; size < 5; size++) {
    const tier = Loot.DATA.tiers[size];
    assert.equal(tier.shared.reduce((sum, row) => sum + row.weight, 0) + tier.localWeight, tier.totalWeight);
    for (const [port, local] of Object.entries(tier.ports)) {
      supported++;
      const bag = tasks.rewardBags[port][size];
      const definition = core.CacheDefinitions.getItem(bag);
      assert.equal(definition.inventoryActions[0], 'Open');
      assert.equal(definition.params.get(2645), size, 'cache size parameter');
      assert.ok(Loot.tableFor(bag));
      for (const row of [...tier.shared, ...local]) {
        const itemId = id(row.item);
        assert.ok(itemId > 0, row.item);
        assert.ok(Number.isSafeInteger(row.min) && row.min > 0 && row.max >= row.min);
        assert.ok(Number.isSafeInteger(row.weight) && row.weight > 0);
        const { p, inv } = fixture();
        const output = new core.Item(itemId, row.max);
        assert.equal(inv.getAddableAmount(output), row.max, `maximum ${row.item} fits a real inventory`);
        if (row.item.startsWith('cert_')) assert.ok(core.CacheDefinitions.getItem(itemId).noteTemplate >= 0, row.item);
      }
    }
  }
  assert.equal(supported, 95);
  for (const task of tasks.tasks.filter(t => t.type === 'courier' && t.board)) {
    const size = [400, 1000, 2500, 6000].filter(xp => task.xp >= xp).length;
    assert.ok(Loot.tableFor(tasks.rewardBags[task.destination][size]), `courier ${task.id} bag supported`);
  }
});

test('weighted intervals select every shared and destination row with inclusive quantity endpoints', () => {
  const Loot = require('../plugins/skills/sailing/porttasks/Loot.PortTasks');
  for (const tier of Loot.DATA.tiers) for (const local of Object.values(tier.ports)) {
    const table = { tier, local };
    let start = 0;
    for (const row of tier.shared) {
      for (const endpoint of [0, 0.999999999]) {
        const reward = random([(start + 0.5) / tier.totalWeight, endpoint], () => Loot.roll(table));
        assert.deepEqual(reward, { item: row.item, amount: endpoint ? row.max : row.min });
      }
      start += row.weight;
    }
    start = 0;
    const total = local.reduce((sum, row) => sum + row.weight, 0);
    for (const row of local) {
      const reward = random([0.999999999, (start + 0.5) / total, 0.999999999], () => Loot.roll(table));
      assert.deepEqual(reward, { item: row.item, amount: row.max });
      start += row.weight;
    }
  }
});

test('unobtainable cache combinations refuse without consuming the bag', () => {
  const { p, inv, bag } = fixture(1, 'port_task_lootsack_t0_aldarin');
  open(p);
  assert.equal(inv.getAmount(bag), 1);
});
