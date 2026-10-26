// Run after `yarn build`: node --test tests/ring-of-elements.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { ItemIdentifiers } = require("../dist/util/ItemIdentifiers");
const Ring = require("../plugins/items/RingOfElements.plugin");

const items = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "definitions", "item-gameplay.json"), "utf8"),
);
const byId = new Map(items.map((item) => [item.id, item]));

function createPlayer() {
  const attributes = new Map();
  const messages = [];
  const deleted = [];
  let hasRunes = true;
  const player = {
    attributes,
    deleted,
    messages,
    setHasRunes: (value) => { hasRunes = value; },
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getInventory: () => ({
      contains: () => hasRunes,
      deleteNumber: (id, amount) => deleted.push([id, amount]),
      refreshItems: () => {},
    }),
    getEquipment: () => ({ refreshItems: () => {} }),
    sendMessage: (message) => messages.push(message),
  };
  return player;
}

const ringItem = (id) => ({
  id,
  getId() { return this.id; },
  setId(value) { this.id = value; },
});

test("the ring of the elements has both ids and they are rings", () => {
  const uncharged = byId.get(ItemIdentifiers.RING_OF_THE_ELEMENTS);
  const charged = byId.get(ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  assert.equal(uncharged?.equipmentType, "RING");
  assert.equal(charged?.equipmentType, "RING");
  assert.equal(uncharged?.tradeable, true, "uncharged rings are tradeable");
  assert.equal(charged?.tradeable, false, "charged rings are untradeable");
  assert.deepEqual(uncharged?.bonuses, new Array(14).fill(0));
});

test("teleport destinations match the Wiki", () => {
  const byLabel = new Map(Ring._test.TELEPORTS.map(({ label, destination }) => [
    label,
    [destination.getX(), destination.getY(), destination.getZ()],
  ]));
  assert.deepEqual(byLabel.get("Air Altar"), [2981, 3276, 0]);
  assert.deepEqual(byLabel.get("Water Altar"), [3170, 3155, 0]);
  assert.deepEqual(byLabel.get("Earth Altar"), [3288, 3468, 0]);
  assert.deepEqual(byLabel.get("Fire Altar"), [3314, 3279, 0]);
  assert.deepEqual(
    Ring._test.WORN_ACTIONS.map((action) => (action.type === "last" ? "last" : action.teleport.label)),
    ["last", "Air Altar", "Water Altar", "Earth Altar", "Fire Altar"]
  );
});

test("charges are per player, capped at 10,000, and drive the ring's id", () => {
  const player = createPlayer();
  assert.equal(Ring._test.getCharges(player), 0);
  Ring._test.setCharges(player, 5);
  assert.equal(Ring._test.getCharges(player), 5);
  Ring._test.setCharges(player, 99999);
  assert.equal(Ring._test.getCharges(player), Ring._test.MAX_CHARGES);
  const item = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS);
  Ring._test.syncRing(player, item, 5);
  assert.equal(item.getId(), ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  Ring._test.syncRing(player, item, 0);
  assert.equal(item.getId(), ItemIdentifiers.RING_OF_THE_ELEMENTS);
});

test("a charge consumes one of each elemental rune and one law rune", () => {
  const player = createPlayer();
  const item = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS);
  assert.equal(Ring._test.handleChargeAttempt(player, item), true);
  assert.equal(Ring._test.getCharges(player), 1);
  assert.equal(item.getId(), ItemIdentifiers.RING_OF_THE_ELEMENTS_4, "the ring becomes charged");
  const consumed = player.deleted.map(([id]) => id).sort((a, b) => a - b);
  assert.deepEqual(consumed, [
    ItemIdentifiers.AIR_RUNE, ItemIdentifiers.WATER_RUNE, ItemIdentifiers.EARTH_RUNE,
    ItemIdentifiers.FIRE_RUNE, ItemIdentifiers.LAW_RUNE,
  ].sort((a, b) => a - b));

  player.setHasRunes(false);
  assert.equal(Ring._test.handleChargeAttempt(player, item), false);
  assert.equal(Ring._test.getCharges(player), 1, "no runes, no charge");
  assert.match(player.messages.at(-1), /one of each elemental rune/);
});

const { TeleportHandler } = require("../dist/game/model/teleportation/TeleportHandler");

/** Teleports wait for `land()`; `allowed` decides checkReqs. */
function stubTeleports(t, allowed = true) {
  const arrivals = [];
  t.mock.method(TeleportHandler, "checkReqs", () => allowed);
  t.mock.method(TeleportHandler, "teleport", (player, target, type, warning, onArrival) => arrivals.push(onArrival));
  return { arrivals, land: () => arrivals.shift()() };
}

/** A player whose rings sit in real-looking inventory and equipment slots. */
function carrier() {
  const player = createPlayer();
  const inventory = new Array(28).fill(null);
  const equipment = new Array(14).fill(null);
  player.inventory = inventory;
  player.equipment = equipment;
  player.getInventory = () => ({ getItems: () => inventory, refreshItems() {} });
  player.getEquipment = () => ({ getItems: () => equipment, refreshItems() {} });
  return player;
}

test("a teleport spends its charge on arrival, and a refused one spends nothing", (t) => {
  const player = carrier();
  const ring = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  player.inventory[0] = ring;
  Ring._test.setCharges(player, 1);

  const refused = stubTeleports(t, false);
  assert.equal(Ring._test.teleport(player, ring, Ring._test.TELEPORTS[0].destination, "Air Altar"), false);
  assert.equal(refused.arrivals.length, 0);
  assert.equal(Ring._test.getCharges(player), 1);
  t.mock.restoreAll();

  const { land } = stubTeleports(t);
  Ring._test.teleport(player, ring, Ring._test.TELEPORTS[0].destination, "Air Altar");
  assert.equal(Ring._test.getCharges(player), 1, "nothing is spent before arrival");
  assert.equal(ring.getId(), ItemIdentifiers.RING_OF_THE_ELEMENTS_4);

  // The ring is equipped mid-teleport as a different object.
  player.inventory[0] = null;
  const worn = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  player.equipment[12] = worn;
  land();
  assert.equal(Ring._test.getCharges(player), 0);
  assert.equal(worn.getId(), ItemIdentifiers.RING_OF_THE_ELEMENTS, "the last charge leaves the uncharged ring");
  assert.equal(player.attributes.get("ring-of-elements:last-destination"), "Air Altar");
});

test("destroying the charged ring keeps the player's charges for their next ring", (t) => {
  const player = carrier();
  Ring._test.setCharges(player, 5);
  player.inventory[0] = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  // Destroy (the charged ring is untradeable) removes the item, not the stored charges.
  player.inventory[0] = null;
  assert.equal(Ring._test.getCharges(player), 5);

  const replacement = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS);
  player.inventory[3] = replacement;
  const { land } = stubTeleports(t);
  Ring._test.teleport(player, replacement, Ring._test.TELEPORTS[2].destination, "Earth Altar");
  land();
  assert.equal(Ring._test.getCharges(player), 4);
  assert.equal(replacement.getId(), ItemIdentifiers.RING_OF_THE_ELEMENTS_4, "the new ring shows the stored charges");
});

test("two players' rings of the elements never share charges", (t) => {
  const alice = carrier();
  const bob = carrier();
  Ring._test.setCharges(alice, 3);
  Ring._test.setCharges(bob, 9);
  const aliceRing = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  const bobRing = ringItem(ItemIdentifiers.RING_OF_THE_ELEMENTS_4);
  alice.inventory[0] = aliceRing;
  bob.equipment[12] = bobRing;

  const { land } = stubTeleports(t);
  Ring._test.teleport(alice, aliceRing, Ring._test.TELEPORTS[1].destination, "Water Altar");
  Ring._test.teleport(bob, bobRing, Ring._test.TELEPORTS[3].destination, "Fire Altar");
  land();
  land();
  assert.equal(Ring._test.getCharges(alice), 2);
  assert.equal(Ring._test.getCharges(bob), 8);
  assert.equal(alice.attributes.get("ring-of-elements:last-destination"), "Water Altar");
  assert.equal(bob.attributes.get("ring-of-elements:last-destination"), "Fire Altar");
});
