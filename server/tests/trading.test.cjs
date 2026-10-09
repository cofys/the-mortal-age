// Two-player trade simulation — conservation, decline, and regression tests.
// Run after `yarn build` (npx tsc --build): node --test tests/trading.test.cjs
//
// Drives the real engine Trading class with two mock players through the full
// flow: request -> offer -> accept -> confirm -> accept, asserting items are
// neither duplicated nor lost. Also covers three fixed defects:
//   1. handleItem with a crafted out-of-range slot no longer throws.
//   2. Offering a stackable whose metadata matches no existing trade stack
//      (and no free slot) no longer deletes it from the inventory.
//   3. Confirm-accept with no room no longer destroys the offered items.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const { Item } = require("../dist/game/model/Item");
const { Inventory } = require("../dist/game/model/container/impl/Inventory");
const { PlayerStatus } = require("../dist/game/model/PlayerStatus");
const { Trading } = require("../dist/game/content/Trading");

const COINS = 995;
const FEATHERS = 314;
const BRONZE_SWORD = 1277;
const JUNK_START = 20000; // filler ids for filling inventories
const UNTRADEABLE_ROCK = 12345;

const DEFINITIONS = {
  [COINS]: { name: "Coins", stackable: true },
  [FEATHERS]: { name: "Feather", stackable: true },
  [BRONZE_SWORD]: { name: "Bronze sword" },
  [UNTRADEABLE_ROCK]: { name: "Pet rock", tradeable: false },
};
for (let i = 0; i < 40; i++) DEFINITIONS[JUNK_START + i] = { name: `Junk ${i}` };
ItemDefinition.forId = (id) => {
  const def = DEFINITIONS[id] ?? { name: "null" };
  return {
    getId: () => id,
    getName: () => def.name,
    getValue: () => 1,
    isStackable: () => def.stackable === true,
    isNoted: () => false,
    unNote: () => id,
    getNoteId: () => -1,
    getPlaceholderId: () => -1,
    isTradeable: () => def.tradeable !== false,
    isSellable: () => true,
    isDropable: () => true,
  };
};

function createPlayer(name, index) {
  const sender = new Proxy({}, { get: () => () => sender });
  const messages = [];
  const state = { status: PlayerStatus.NONE, interfaceId: -1 };
  const player = {
    messages,
    getUsername: () => name,
    getIndex: () => index,
    sendMessage: (m) => messages.push(m),
    getPacketSender: () => sender,
    getSession: () => ({ sendClientPacket: () => {} }),
    getFrameUpdater: () => ({ clear: () => {} }),
    getStatus: () => state.status,
    setStatus: (s) => { state.status = s; },
    getInterfaceId: () => state.interfaceId,
    setInterfaceId: (id) => { state.interfaceId = id; },
    isPlayerBot: () => false,
    getAttribute: () => true, // ATTR_SKIP_PERSISTENCE: never touch disk in tests
  };
  player.inventory = new Inventory(player);
  player.inventory.resetItems();
  player.trading = new Trading(player);
  player.getTrading = () => player.trading;
  player.getInventory = () => player.inventory;
  return player;
}

/** Total amount of `id` across both players' inventories and trade containers. */
function totalOf(a, b, id) {
  let total = 0;
  for (const p of [a, b]) {
    total += p.getInventory().getAmount(id);
    total += p.getTrading().getContainer().getAmount(id);
  }
  return total;
}

function openTrade(a, b) {
  a.getTrading().requestTrade(b);
  b.getTrading().requestTrade(a);
  assert.equal(a.getTrading().getState(), 2); // TRADE_SCREEN
  assert.equal(b.getTrading().getState(), 2);
}

/** Find the inventory slot holding `id` (optionally with matching meta). */
function findSlot(player, id, meta) {
  const items = player.getInventory().getItems();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it != null && it.getId() === id) {
      if (meta === undefined) return i;
      if (JSON.stringify(it.getMeta() ?? null) === JSON.stringify(meta)) return i;
    }
  }
  return -1;
}

function offer(player, id, amount, meta) {
  const slot = findSlot(player, id, meta);
  assert.notEqual(slot, -1, `expected ${id} in inventory`);
  player.getTrading().handleItem(
    id, amount, slot, player.getInventory(), player.getTrading().getContainer()
  );
}

function acceptBoth(a, b) {
  a.getTrading().acceptTrade();
  b.getTrading().acceptTrade();
}

/** Simulate time passing so the 1s anti-double-click button delay expires. */
function settleDelays(a, b) {
  a.getTrading().getButtonDelay().stop();
  b.getTrading().getButtonDelay().stop();
}

test("full trade: offers swap with no duplication or loss", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(COINS, 1000), false);
  a.getInventory().add(new Item(BRONZE_SWORD, 1), false);
  b.getInventory().add(new Item(FEATHERS, 500), false);

  openTrade(a, b);
  offer(a, COINS, 1000);
  offer(a, BRONZE_SWORD, 1);
  offer(b, FEATHERS, 500);

  assert.equal(a.getTrading().getContainer().getAmount(COINS), 1000);
  assert.equal(b.getTrading().getContainer().getAmount(FEATHERS), 500);

  acceptBoth(a, b); // first accept -> confirm screen
  assert.equal(a.getTrading().getState(), 4); // CONFIRM_SCREEN
  settleDelays(a, b);
  acceptBoth(a, b); // second accept -> items move

  assert.equal(a.getTrading().getState(), 0); // NONE
  assert.equal(a.getInventory().getAmount(FEATHERS), 500);
  assert.equal(a.getInventory().getAmount(COINS), 0);
  assert.equal(b.getInventory().getAmount(COINS), 1000);
  assert.equal(b.getInventory().getAmount(BRONZE_SWORD), 1);
  assert.equal(b.getInventory().getAmount(FEATHERS), 0);
  // Conservation across the whole system.
  assert.equal(totalOf(a, b, COINS), 1000);
  assert.equal(totalOf(a, b, FEATHERS), 500);
  assert.equal(totalOf(a, b, BRONZE_SWORD), 1);
  assert.ok(a.messages.includes("Trade accepted!"));
});

test("declining returns offered items to inventory", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(COINS, 250), false);

  openTrade(a, b);
  offer(a, COINS, 250);
  assert.equal(a.getInventory().getAmount(COINS), 0);

  b.getTrading().closeTrade(); // decline
  assert.equal(a.getInventory().getAmount(COINS), 250);
  assert.equal(totalOf(a, b, COINS), 250);
  assert.equal(a.getTrading().getState(), 0);
  assert.equal(b.getTrading().getState(), 0);
});

test("modifying an offer after accepting resets both accept states", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(COINS, 1000), false);

  openTrade(a, b);
  offer(a, COINS, 500);
  a.getTrading().acceptTrade();
  b.getTrading().acceptTrade();
  assert.equal(a.getTrading().getState(), 4); // CONFIRM_SCREEN

  // Back out is not possible from confirm; use a fresh trade to test the
  // offer-screen reset path instead.
  const c = createPlayer("cara", 3);
  const d = createPlayer("dan", 4);
  c.getInventory().add(new Item(COINS, 1000), false);
  openTrade(c, d);
  offer(c, COINS, 500);
  c.getTrading().acceptTrade();
  assert.equal(c.getTrading().getState(), 3); // ACCEPTED_TRADE_SCREEN
  offer(c, COINS, 200); // modify offer -> accept reset
  assert.equal(c.getTrading().getState(), 2); // TRADE_SCREEN
  assert.equal(c.getTrading().getContainer().getAmount(COINS), 700);
});

test("untradeable items cannot be offered", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(UNTRADEABLE_ROCK, 1), false);

  openTrade(a, b);
  offer(a, UNTRADEABLE_ROCK, 1);
  assert.equal(a.getTrading().getContainer().getValidItems().length, 0);
  assert.equal(a.getInventory().getAmount(UNTRADEABLE_ROCK), 1);
  assert.ok(a.messages.includes("You cannot trade that item."));
});

test("crafted out-of-range slot does not throw", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(COINS, 100), false);

  openTrade(a, b);
  assert.doesNotThrow(() => {
    a.getTrading().handleItem(COINS, 1, 999, a.getInventory(), a.getTrading().getContainer());
    a.getTrading().handleItem(COINS, 1, -1, a.getInventory(), a.getTrading().getContainer());
  });
  // Nothing moved.
  assert.equal(a.getInventory().getAmount(COINS), 100);
  assert.equal(a.getTrading().getContainer().getValidItems().length, 0);
});

test("mismatched slot/item id does not move anything", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(COINS, 100), false);

  openTrade(a, b);
  const swordSlot = 5; // empty slot, but packet claims coins
  a.getTrading().handleItem(COINS, 1, swordSlot, a.getInventory(), a.getTrading().getContainer());
  assert.equal(a.getInventory().getAmount(COINS), 100);
  assert.equal(a.getTrading().getContainer().getValidItems().length, 0);
});

test("meta-mismatched stackable offer is kept, not deleted", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(COINS, 1000, { tag: "a" }), false);

  openTrade(a, b);
  // Fill the whole trade container with same-id, different-meta stacks.
  const container = a.getTrading().getContainer();
  for (let i = 0; i < 28; i++) {
    container.add(new Item(COINS, 1, { n: i }), false);
  }
  assert.equal(container.getFreeSlots(), 0);

  offer(a, COINS, 500, { tag: "a" });
  // The offer must be refused; the coins stay in the inventory.
  assert.equal(a.getInventory().getAmount(COINS), 1000);
  assert.equal(container.getAmount(COINS), 28);
});

test("confirm with a full inventory aborts instead of destroying items", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(BRONZE_SWORD, 1), false);
  // B has exactly one free slot, so the first-accept space check passes.
  for (let i = 0; i < 27; i++) {
    b.getInventory().add(new Item(JUNK_START + i, 1), false);
  }

  openTrade(a, b);
  offer(a, BRONZE_SWORD, 1);
  acceptBoth(a, b); // -> confirm screen
  assert.equal(a.getTrading().getState(), 4);

  // B's last slot fills before the final accept (e.g. a queued pickup).
  b.getInventory().add(new Item(JUNK_START + 27, 1), false);
  assert.equal(b.getInventory().getFreeSlots(), 0);

  settleDelays(a, b);
  a.getTrading().acceptTrade();
  b.getTrading().acceptTrade();

  // Trade aborted, sword returned to A, nothing destroyed.
  assert.equal(a.getTrading().getState(), 0);
  assert.equal(a.getInventory().getAmount(BRONZE_SWORD), 1);
  assert.equal(totalOf(a, b, BRONZE_SWORD), 1);
  assert.ok(
    a.messages.some((m) => m.includes("not enough free inventory space")) ||
    b.messages.some((m) => m.includes("not enough free inventory space"))
  );
});

test("accept is blocked when the other player lacks space", () => {
  const a = createPlayer("alice", 1);
  const b = createPlayer("bob", 2);
  a.getInventory().add(new Item(BRONZE_SWORD, 1), false);
  for (let i = 0; i < 28; i++) {
    b.getInventory().add(new Item(JUNK_START + i, 1), false);
  }

  openTrade(a, b);
  offer(a, BRONZE_SWORD, 1);
  a.getTrading().acceptTrade();
  // Still on the offer screen: B cannot hold the sword.
  assert.equal(a.getTrading().getState(), 2);
  assert.ok(a.messages.some((m) => m.includes("will not be able to hold")));
});
