// Run after `yarn build`: node --test tests/item-prices.test.cjs
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const ItemDefinitionLoader = require("../plugins/items/ItemDefinitionLoader.plugin");
const PRICES = require("../data/definitions/item-prices.json").data;
const ALCH = require("../data/definitions/item-alch.json");

const TEAM_6 = 4325;
const WHIP = 4151;
const BONES = 526;

function quote(id) {
  const value = PRICES[String(id)];
  assert.ok(value, `item ${id} is in the price table`);
  const quoted = [value.high, value.low].filter((price) => Number.isSafeInteger(price) && price > 0);
  assert.ok(quoted.length, `item ${id} has a live quote`);
  return { ...value, buy: Math.max(...quoted), sell: Math.min(...quoted) };
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  ItemDefinitionLoader._test.loadItemPrices();
  ItemDefinitionLoader._test.loadItemAlch();
});

test("buy is the higher guide price and sell the lower", () => {
  const live = quote(TEAM_6);
  const definition = ItemDefinition.forId(TEAM_6);
  assert.equal(definition.getGrandExchangeValue(), live.buy);
  assert.equal(definition.getGrandExchangeSellValue(), live.sell);
  assert.ok(definition.getGrandExchangeValue() >= definition.getGrandExchangeSellValue());
});

test("alch values come from the osrsreboxed item dump", () => {
  const definition = ItemDefinition.forId(WHIP);
  assert.equal(definition.getHighAlchValue(), ALCH[WHIP].highalch);
  assert.equal(definition.getLowAlchValue(), ALCH[WHIP].lowalch);
});

test("items the item dump marks unalchable stay at zero", () => {
  const definition = ItemDefinition.forId(BONES);
  assert.equal(ALCH[BONES].highalch, 0);
  assert.equal(definition.getHighAlchValue(), 0);
  assert.equal(definition.getLowAlchValue(), 0);
});

test("the noted copy mirrors buy and sell", () => {
  const live = quote(WHIP);
  const definition = ItemDefinition.forId(WHIP);
  assert.equal(definition.isNoted(), false);
  const note = ItemDefinition.forId(definition.getNoteId());
  assert.ok(note.isNoted());
  assert.equal(note.getNoteId(), WHIP);
  assert.equal(note.getGrandExchangeValue(), live.buy);
  assert.equal(note.getGrandExchangeSellValue(), live.sell);
});
