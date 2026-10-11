// Run with: node server/scripts/looting-bag-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const hooks = {};
const packets = [];
let removed = 0;
const dropped = [];
let inWilderness = true;
const bag = {
  id: 11941, meta: { lootingBag: [{ id: 995, amount: 7 }] },
  getId() { return this.id; }, setId(id) { this.id = id; },
  getDefinition: () => ({ getName: () => 'Looting bag' }),
  getMetaValue(key) { return this.meta[key]; },
  setMetaValue(key, value) { this.meta[key] = value; },
};
const sender = new Proxy({}, { get: (_, name) => (...args) => packets.push([name, ...args]) });
let inventoryItems = [bag];
let amountAction;
const inventory = {
  getItems: () => inventoryItems, getValidItems: () => inventoryItems.filter(Boolean),
  capacity: () => inventoryItems.length, refreshItems() {}, getFreeSlots: () => 0,
  deleteAtSlot(slot, amount) {
    const item = inventoryItems[slot];
    item.amount -= amount;
    if (!item.amount) inventoryItems[slot] = null;
  },
};
const player = {
  getInventory: () => inventory,
  setEnteredAmountAction(action) { amountAction = action; },
  getPacketSender: () => sender, getLastItemPickup: () => ({ reset() {} }),
  sendMessage: (message) => sender.sendMessage(message),
};
const moduleStub = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/items/LootingBag.plugin.js'), 'utf8'), {
  module: moduleStub,
  require(name) {
    if (name.endsWith('/Item')) return { Item: class {
      constructor(id, amount, meta) { Object.assign(this, { id, amount, meta }); }
      getId() { return this.id; } getMeta() { return this.meta; }
    } };
    if (name.endsWith('/ItemIdentifiers')) return { ItemIdentifiers: { VIAL_OF_WATER: 227 } };
    if (name.endsWith('/ItemDefinition')) return { ItemDefinition: {
      // id 1964 stands in for a noted food (banana 1963's note).
      forId: (id) => ({ unNote: () => (id === 1964 ? 1963 : id), getValue: () => 1, isStackable: () => true, isNoted: () => id === 1964 }),
    } };
    if (name.endsWith('/Wilderness')) return { Wilderness: { isIn: () => inWilderness } };
    if (name.endsWith('FeroxEnclave')) return { isInsideEnclave: () => false };
    if (name.endsWith('Food.plugin')) return { isFoodItem: (id) => id === 1963 };
    if (name.endsWith('Potions.plugin')) return { isPotionItem: () => false };
    if (name.endsWith('/ItemOnGroundManager')) return { ItemOnGroundManager: {
      deregister() { removed++; },
      registerGlobal(player, item) { dropped.push(item); },
      registerLocation(player, item, location) { dropped.push(item); },
    } };
    return {};
  },
});
moduleStub.exports.register(new Proxy({}, { get: (_, name) => (...args) => { hooks[name] = args; } }));
const actions = hooks.onItemAction[1];
actions.Open({ player, item: bag });
assert.equal(bag.id, 22586);
assert.equal(bag.meta.lootingBag[0].amount, 7);
assert(!packets.some(([name]) => name === 'sendSubInterface'));
actions.Check({ player, item: bag });
assert(packets.some(([name, target, group, type]) => name === 'sendSubInterface' && target === ((161 << 16) | 74) && group === 81 && type === 3));
const script = packets.find(([name]) => name === 'sendInterfaceScript');
assert.equal(script[1], 149);
assert.equal(script[5][517].slots[0].quantity, 7);
// Empty bag avoids needing real item definitions in this isolated hook check.
bag.meta.lootingBag = [];
const loot = { getId: () => 995, getAmount: () => 1, isValid: () => true,
  isTradeable: () => true,
  getDefinition: () => ({ getName: () => 'Coins' }) };
const event = { player, groundItem: { getItem: () => loot }, handled: false };
hooks.onGroundItemPickup[0](event);
assert.equal(event.handled, true);
assert.equal(removed, 1);
const makeLoot = (amount, meta = null) => ({ ...loot, amount, getAmount() { return this.amount; }, getMeta: () => meta });
bag.meta.lootingBag = [];
inventoryItems = [bag, makeLoot(1), makeLoot(1), makeLoot(1), makeLoot(1, { charge: 2 })];
hooks.onItemOnItem[0]({ player, usedItem: bag, usedWithItem: inventoryItems[1] });
assert(amountAction);
amountAction.execute(3);
assert.equal(bag.meta.lootingBag[0].amount, 3);
assert.equal(inventoryItems.filter(Boolean).length, 2);
bag.meta.lootingBag = [];
inventoryItems = [bag, makeLoot(1)];
amountAction = null;
hooks.onItemOnItem[0]({ player, usedItem: inventoryItems[1], usedWithItem: bag });
assert.equal(amountAction, null);
assert.equal(bag.meta.lootingBag[0].amount, 1);
inventoryItems = [bag, makeLoot(20)];
hooks.onItemOnItem[0]({ player, usedItem: bag, usedWithItem: inventoryItems[1] });
amountAction.execute(7);
assert.equal(inventoryItems[1].amount, 13);
assert.equal(bag.meta.lootingBag[0].amount, 8);
inventoryItems = [makeLoot(20)];
amountAction.execute(7);
assert.equal(inventoryItems[0].amount, 20);
// Destroy in the wilderness: the bag is removed, un-noted food and vials of water are
// destroyed, coins and noted items drop to the floor where anyone can pick them up.
bag.meta.lootingBag = [
  { id: 995, amount: 5 },   // coins
  { id: 1963, amount: 2 },  // banana (un-noted food)
  { id: 1964, amount: 1 },  // noted banana
  { id: 227, amount: 3 },   // vial of water
];
inventoryItems = [bag];
let droppedSoFar = dropped.length;
actions.Destroy({ player, item: bag });
assert.equal(inventoryItems.filter(Boolean).length, 0);
assert.deepEqual(dropped.slice(droppedSoFar).map((entry) => entry.getId()).sort((a, b) => a - b), [995, 1964]);
// Outside the wilderness (including the Ferox Enclave): everything is lost, nothing drops.
inWilderness = false;
bag.meta.lootingBag = [{ id: 995, amount: 5 }, { id: 1964, amount: 1 }];
inventoryItems = [bag];
droppedSoFar = dropped.length;
actions.Destroy({ player, item: bag });
assert.equal(inventoryItems.filter(Boolean).length, 0);
assert.equal(dropped.length, droppedSoFar);
inWilderness = true;
// On death: the bag is always lost; the killer gets everything inside except food and
// potions (noted or not), which are destroyed instead.
bag.meta.lootingBag = [{ id: 995, amount: 5 }, { id: 1963, amount: 2 }, { id: 1964, amount: 1 }];
inventoryItems = [bag];
const deathEvent = { player, item: bag, location: {}, handled: false };
hooks.onPlayerDeathItemDrop[0](deathEvent);
assert.equal(deathEvent.handled, true);
droppedSoFar = dropped.length;
hooks.onPlayerDefeated[0]({ killer: {}, victim: player });
assert.deepEqual(dropped.slice(droppedSoFar).map((entry) => entry.getId()).sort((a, b) => a - b), [995]);
inventoryItems = [bag];
actions.Close({ player, item: bag });
assert.equal(bag.id, 11941);
event.handled = false;
hooks.onGroundItemPickup[0](event);
assert.equal(event.handled, false);
assert.equal(removed, 1);
console.log('Looting bag smoke checks passed');
