const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { ItemActionPacketListener: Actions } = require('../dist/net/packet/impl/ItemActionPacketListener');
let core;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(3222, 3218);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));
const id = name => core.CacheDefinitions.getObjId(name);
const bagId = size => id(`port_task_lootsack_t${size}_coins`);
function fixture(amount = 1, size = 0) {
  const p = new Player(null);
  p.setUsername('coinbagqa');
  p.getSession = () => ({ sendClientPacket: () => true });
  const messages = [];
  p.sendMessage = message => messages.push(message);
  const inv = p.getInventory(), bag = bagId(size);
  inv.setItem(0, new core.Item(bag, amount));
  return { p, inv, messages, bag };
}
function open(p, slot = 0) {
  return Actions.handleAction(p, core.Inventory.INTERFACE_ID, p.getInventory().getItems()[slot].getId(), slot, 1, 'Open');
}
function rng(value, run) {
  const old = Math.random;
  Math.random = () => value;
  try { return run(); } finally { Math.random = old; }
}
function fill(inv, start = 1) {
  for (let slot = start; slot < 28; slot++) inv.setItem(slot, new core.Item(id('knife')));
}

test('all five cache Open options pay inclusive current Wiki quantity endpoints', () => {
  const ranges = [[800, 1200], [1600, 2400], [2400, 3600], [3600, 5400], [6400, 9600]];
  for (let size = 0; size < 5; size++) for (const [random, expected] of [[0, ranges[size][0]], [0.999999999, ranges[size][1]]]) {
    const { p, inv, bag } = fixture(1, size);
    const def = core.CacheDefinitions.getItem(bag);
    assert.equal(def.inventoryActions[0], 'Open');
    assert.equal(def.params.get(2645), size);
    assert.equal(def.params.get(2646), id('coins'));
    rng(random, () => open(p));
    assert.equal(inv.getAmount(bag), 0);
    assert.equal(inv.getAmount(id('coins')), expected, `size ${size}, RNG ${random}`);
  }
});

test('a full inventory and remaining bag stack preserve every input and award no partial coins', () => {
  const { p, inv, bag, messages } = fixture(2);
  fill(inv);
  const before = inv.getCopiedItems();
  rng(0, () => open(p));
  assert.deepEqual(inv.getItems(), before);
  assert.equal(inv.getAmount(bag), 2);
  assert.equal(inv.getAmount(id('coins')), 0);
  assert.ok(messages.includes('Not enough space in your inventory.'));
});

test('the last bag frees its exact slot and can open in a full inventory', () => {
  const { p, inv, bag } = fixture();
  fill(inv);
  const other = inv.getItems()[1];
  rng(0, () => open(p));
  assert.equal(inv.getAmount(bag), 0);
  assert.equal(inv.getItems()[0].getId(), id('coins'));
  assert.equal(inv.getItems()[0].getAmount(), 800);
  assert.equal(inv.getItems()[1], other);
});

test('existing matching coins allow a full inventory opening without freeing the bag stack', () => {
  const { p, inv, bag } = fixture(2);
  fill(inv);
  inv.setItem(1, new core.Item(id('coins'), 10));
  rng(0, () => open(p));
  assert.equal(inv.getAmount(bag), 1);
  assert.equal(inv.getAmount(id('coins')), 810);
});

test('one coin short of stack capacity preserves the bag and whole failed roll until the exact boundary fits', () => {
  const { MAX_STACK_AMOUNT: CAP } = require('../dist/game/model/container/StackType');
  const { p, inv, bag } = fixture();
  inv.setItem(1, new core.Item(id('coins'), CAP - 799));
  const held = inv.getItems()[0];
  rng(0, () => open(p));
  assert.equal(inv.getItems()[0], held);
  assert.equal(inv.getAmount(bag), 1);
  assert.equal(inv.getAmount(id('coins')), CAP - 799);
  inv.deleteAtSlot(1, 1, false);
  rng(0.999999, () => open(p));
  assert.equal(inv.getAmount(bag), 0);
  assert.equal(inv.getAmount(id('coins')), CAP, 'retry retains 800 rather than rerolling 1200');
});

test('native packet widget UID consumes only the clicked metadata bag stack', () => {
  const { ClientConnection } = require('../dist/net/NetworkBuilder');
  const { p, inv, bag } = fixture(2);
  inv.setItem(4, new core.Item(bag, 3, { fixture: ['retained'] }));
  const first = inv.getItems()[0], clicked = inv.getItems()[4];
  rng(0, () => ClientConnection.prototype.inventoryAction.call({ player: p }, {
    type: 'inventory_action', widgetId: core.CacheDefinitions.getComponentId('inventory:items'),
    itemId: bag, slot: 4, optionIndex: 1, option: 'Open',
  }));
  assert.equal(inv.getItems()[0], first);
  assert.equal(first.getAmount(), 2);
  assert.equal(inv.getItems()[4], clicked);
  assert.equal(clicked.getAmount(), 2);
  assert.deepEqual(clicked.getMeta(), { fixture: ['retained'] });
});

test('an unrelated metadata coin stack is neither merged nor overwritten', () => {
  const { p, inv } = fixture(2);
  inv.setItem(1, new core.Item(id('coins'), 99, { preset: true }));
  fill(inv, 2);
  rng(0, () => open(p));
  assert.equal(inv.getItems()[0].getAmount(), 2);
  assert.equal(inv.getItems()[1].getAmount(), 99);
  assert.deepEqual(inv.getItems()[1].getMeta(), { preset: true });
  inv.deleteAtSlot(2, 1, false);
  rng(0.999999, () => open(p));
  assert.equal(inv.getItems()[2].getId(), id('coins'));
  assert.equal(inv.getItems()[2].getAmount(), 800);
  assert.equal(inv.getItems()[2].getMeta(), null);
});

test('real busy, dead, placement, stale and equipment-source contexts cannot consume a bag', () => {
  const { PlayerStatus } = require('../dist/game/model/PlayerStatus');
  for (const setup of [p => p.setStatus(PlayerStatus.TRADING), p => p.setHitpoints(0), p => p.setNeedsPlacement(true)]) {
    const { p, inv, bag } = fixture();
    setup(p);
    open(p);
    assert.equal(inv.getAmount(bag), 1);
  }
  const { p, inv, bag } = fixture();
  for (const event of [
    { interfaceId: core.Inventory.INTERFACE_ID, item: new core.Item(bag) },
    { interfaceId: core.Equipment.INVENTORY_INTERFACE_ID, item: inv.getItems()[0] },
  ]) PM.emitItemAction({ player: p, itemId: bag, slot: 0, clickType: 1, option: 'Open', handled: false, ...event });
  assert.equal(inv.getAmount(bag), 1);
});

test('repeat clicks consume only the actual bag count; Examine cannot award', () => {
  const { p, inv, bag } = fixture(2);
  const { ClientConnection } = require('../dist/net/NetworkBuilder');
  ClientConnection.prototype.inventoryAction.call({ player: p }, { type: 'inventory_action', widgetId: core.CacheDefinitions.getComponentId('inventory:items'), itemId: bag, slot: 0, optionIndex: 10, option: 'Examine' });
  assert.equal(inv.getAmount(bag), 2);
  rng(0, () => { open(p); open(p); Actions.handleAction(p, core.Inventory.INTERFACE_ID, bag, 0, 1, 'Open'); });
  assert.equal(inv.getAmount(bag), 0);
  assert.equal(inv.getAmount(id('coins')), 1600);
});

test('blocked payout survives real bank transfer and save hydration, then the next bag rolls fresh', () => {
  const { PlayerSave } = require('../dist/game/entity/impl/player/persistence/PlayerSave');
  const Json = require('../plugins/persistence/JsonPlayerPersistence.plugin');
  const { p, inv, bag } = fixture(2);
  fill(inv);
  rng(0, () => open(p));
  p.getBank(0).open();
  core.Bank.deposit(p, bag, 0, 2, false);
  assert.equal(inv.getAmount(bag), 0);
  const codec = new Json.JsonPlayerPersistence();
  const saved = JSON.parse(JSON.stringify(PlayerSave.fromPlayer(p), codec.replacer.bind(codec)), codec.reviver.bind(codec));
  const restored = fixture().p;
  codec.hydratePlayerSave(saved).applyToPlayer(restored);
  const ri = restored.getInventory();
  restored.getBank(0).open();
  core.Bank.withdraw(restored, bag, restored.getBank(0).getSlotForItemId(bag), 2, 0);
  restored.getPacketSender().sendInterfaceRemoval();
  rng(0.999999, () => open(restored, ri.getSlotForItemId(bag)));
  assert.equal(ri.getAmount(bag), 2);
  restored.getBank(0).open();
  core.Bank.deposit(restored, id('knife'), ri.getSlotForItemId(id('knife')), 1, false);
  restored.getPacketSender().sendInterfaceRemoval();
  rng(0.999999, () => open(restored, ri.getSlotForItemId(bag)));
  assert.equal(ri.getAmount(id('coins')), 800);
  rng(0.999999, () => open(restored, ri.getSlotForItemId(bag)));
  assert.equal(ri.getAmount(id('coins')), 2000);
  assert.equal(ri.getAmount(bag), 0);
});
