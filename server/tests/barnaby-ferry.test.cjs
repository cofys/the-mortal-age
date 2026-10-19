// Run after `yarn build`: node --test tests/barnaby-ferry.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemIds } = require("../dist/util/IdEnums");

const BarnabyFerry = require("../plugins/world/BarnabyFerry.plugin");

const teleports = [];
BarnabyFerry.register({
  core: {
    ItemIdentifiers: ItemIds,
    TeleportHandler: {
      checkReqs: () => true,
      teleport: (player, destination, type) => teleports.push({ destination, type }),
    },
    TeleportType: { NORMAL: "NORMAL" },
  },
  onNpcInteraction() {},
  onNpcDialogueVariant() {},
  onNpcDialogueCondition() {},
  onCustomEvent() {},
});

function createPlayer({ coins = 100, gloves = 0 } = {}) {
  const equipment = new Array(14).fill(null).map(() => ({ getId: () => 0 }));
  if (gloves) equipment[Equipment.HANDS_SLOT] = { getId: () => gloves };
  let balance = coins;
  const messages = [];
  return {
    messages,
    getEquipment: () => ({ get: (slot) => equipment[slot] }),
    getInventory: () => ({
      getAmount: () => balance,
      deleteNumber: (id, amount) => { balance = Math.max(0, balance - amount); },
      refreshItems: () => {},
    }),
    get balance() { return balance; },
    sendMessage: (message) => messages.push(message),
  };
}

test("the ferry costs 30 coins, or 15 with Karamja gloves", () => {
  assert.equal(BarnabyFerry._test.fareFor(createPlayer()), 30);
  assert.equal(BarnabyFerry._test.fareFor(createPlayer({ gloves: ItemIds.KARAMJA_GLOVES_1 })), 15);
  assert.equal(BarnabyFerry._test.fareFor(createPlayer({ gloves: 1234 })), 30);
});

const brimhavenCaptain = {
  getName: () => "Captain Barnaby",
  getActions: () => ["Talk-to", null, "Ardougne", "Rimmington", null],
};

test("a destination option sails there after payment", () => {
  teleports.length = 0;
  const player = createPlayer();
  BarnabyFerry._test.sailToOption({ player, definition: brimhavenCaptain, clickType: 4 });
  assert.equal(player.balance, 70);
  assert.equal(teleports.length, 1);
  assert.equal(teleports[0].destination.getX(), 2916);

  const broke = createPlayer({ coins: 10 });
  BarnabyFerry._test.sailToOption({ player: broke, definition: brimhavenCaptain, clickType: 3 });
  assert.equal(teleports.length, 1);
  assert.equal(broke.balance, 10);
});

test("the Talk-to transcript is the captain's own dock", () => {
  assert.equal(
    BarnabyFerry._test.selectDockVariant({ definition: brimhavenCaptain }),
    "standard-dialogue-if-the-player-is-on-the-dock-in-brimhaven"
  );
  const apeAtoll = { getName: () => "Captain Barnaby", getActions: () => ["Talk-to", null, null, null, null] };
  assert.equal(BarnabyFerry._test.selectDockVariant({ definition: apeAtoll }), null);
});

test("the Talk-to transcript checks the fare and sails on its boarding message", () => {
  teleports.length = 0;
  const condition = (player) => BarnabyFerry._test.answerFareCondition({
    player, definition: brimhavenCaptain, text: "If the player does not have 30 coins:",
  });
  assert.equal(condition(createPlayer()), false);
  assert.equal(condition(createPlayer({ coins: 20 })), true);
  assert.equal(condition(createPlayer({ coins: 20, gloves: ItemIds.KARAMJA_GLOVES_1 })), false);

  const player = createPlayer();
  const event = { player, definition: brimhavenCaptain, text: "You board the ship and sail to Ardougne." };
  BarnabyFerry._test.boardFromDialogue(event);
  assert.equal(event.handled, true);
  assert.equal(player.balance, 70);
  assert.equal(teleports[0].destination.getX(), 2680);
});
