const assert = require("node:assert/strict");
const { test } = require("node:test");
const registerFinalCastleDeposit = require("../plugins/quests/bmr/FinalCastleDeposit.TheBloodMoonRises");

test("the final Castle chest opens the native deposit box only in earned staging", () => {
  const emitted = [];
  let depositHandler;
  let actions;
  const api = {
    onObjectInteraction: (name, registeredActions) => {
      assert.equal(name, "Chest");
      actions = registeredActions;
      depositHandler = registeredActions.Deposit;
    },
    emitCustomEvent: (name, event) => emitted.push({ name, event }),
  };
  registerFinalCastleDeposit(api);
  const attributes = new Map([
    ["quest.the_blood_moon_rises.stage", 100],
    ["quest.the_blood_moon_rises.final-portal-used", true],
  ]);
  let point = { x: 2503, y: 7386, z: 0 };
  const player = {
    getAttribute: (key) => attributes.get(key),
    getLocation: () => ({ getX: () => point.x, getY: () => point.y, getZ: () => point.z }),
    sendMessage() {},
  };
  const invoke = (overrides = {}) => depositHandler({
    player, objectId: 61764, definition: { id: 61765 },
    location: { x: 2503, y: 7386, z: 0 }, option: "Deposit", handled: false, ...overrides,
  });

  assert.equal(typeof depositHandler, "function");
  assert.deepEqual(Object.keys(actions), ["Deposit"]);

  attributes.set("quest.the_blood_moon_rises.stage", 90);
  assert.equal(invoke(), true);
  assert.equal(emitted.length, 0, "the Wyrd chapter cannot deposit through the final chest");

  attributes.set("quest.the_blood_moon_rises.stage", 100);
  point = { x: 3500, y: 3200, z: 0 };
  assert.equal(invoke(), true);
  assert.equal(emitted.length, 0, "an earned portal flag does not allow a remote deposit");

  point = { x: 2503, y: 7386, z: 0 };
  attributes.set("quest.the_blood_moon_rises.final-portal-used", false);
  assert.equal(invoke(), true);
  assert.equal(emitted.length, 0, "the final chapter alone does not unlock the staging chest");

  attributes.set("quest.the_blood_moon_rises.final-portal-used", true);
  const event = { player, objectId: 61764, definition: { id: 61765 },
    location: { x: 2503, y: 7386, z: 0 }, option: "Deposit", handled: false };
  assert.equal(depositHandler(event), true);
  assert.equal(event.handled, true);
  assert.deepEqual(emitted.map(({ name }) => name), ["bank:open-deposit-box"]);
  assert.equal(emitted[0].event.player, player);
});

