const assert = require("node:assert/strict");
const { test } = require("node:test");

test("normal casket selection respects weighted boundaries and inclusive quantity ranges", () => {
  const Rolls = require("../plugins/treasuretrails/Rolls.RewardCaskets");
  const table = {out_of: 4, rolls: [1, 3], entries: [
    {item_id: 3, weight: 1, quantity: [1, 1], noted: false},
    {item_id: 5, weight: 3, quantity: [10, 20], noted: true},
  ]};
  assert.deepEqual(Rolls.rollTable(table, 1, () => 0.249999), [{itemId: 3, amount: 1, noted: false}]);
  let values = [0.25, 0];
  assert.deepEqual(Rolls.rollTable(table, 1, () => values.shift()), [{itemId: 5, amount: 10, noted: true}]);
  assert.deepEqual(Rolls.rollTable(table, 1, () => 0.999999), [{itemId: 5, amount: 20, noted: true}]);
});

test("real elite and master pools remain distinct and support zero remaining normal rolls", () => {
  const Rolls = require("../plugins/treasuretrails/Rolls.RewardCaskets");
  assert.deepEqual(Rolls.roll("elite", 4, () => 0.1), Array.from({length: 4}, () => ({itemId: 1079, amount: 1, noted: false})));
  assert.deepEqual(Rolls.roll("master", 7, () => 0.1), Array.from({length: 7}, () => ({itemId: 1434, amount: 1, noted: false})));
  assert.deepEqual(Rolls.roll("elite", 0), []);
  assert.throws(() => Rolls.roll("elite", 7), /roll/i);
  assert.throws(() => Rolls.roll("master", -1), /roll/i);
});

test("ambiguous, incomplete or unresolved reward data cannot produce loot", () => {
  const Rolls = require("../plugins/treasuretrails/Rolls.RewardCaskets");
  for (const entry of [
    {item_id: 3, weight: 3, quantity: [1, 1], noted: false},
    {item_id: null, weight: 4, quantity: [1, 1], noted: false},
    {item_id: 3, weight: 4, quantity_raw: "1; 3", noted: false},
  ]) assert.throws(() => Rolls.rollTable({out_of: 4, rolls: [1, 3], entries: [entry]}, 1), /reward/i);
});

test("a joint outcome grants every listed item on one roll", () => {
  const Rolls = require("../plugins/treasuretrails/Rolls.RewardCaskets");
  const table = { rolls: [1, 1], out_of: 2, entries: [
    { weight: 1, items: [{ item_id: 2436, quantity: [5, 5], noted: true }, { item_id: 2440, quantity: [5, 5], noted: true }] },
    { item_id: 995, quantity: [1, 1], noted: false, weight: 1 },
  ] };
  assert.deepEqual(Rolls.rollTable(table, 1, () => 0), [{ itemId: 2436, amount: 5, noted: true }, { itemId: 2440, amount: 5, noted: true }]);
  assert.deepEqual(Rolls.rollTable(table, 1, () => 0.75), [{ itemId: 995, amount: 1, noted: false }]);
  assert.throws(() => Rolls.rollTable({ ...table, entries: [{ weight: 2, items: [] }] }, 1, () => 0), /Invalid casket reward entry/);
});

test("every imported tier's table rolls, including hard's joint mega-rare outcome", () => {
  const Rolls = require("../plugins/treasuretrails/Rolls.RewardCaskets");
  const tables = require("../data/definitions/clue-caskets.json").tables;
  for (const tier of Object.keys(tables)) assert.ok(Rolls.roll(tier, tables[tier].rolls[0]).length >= tables[tier].rolls[0], tier);
});
