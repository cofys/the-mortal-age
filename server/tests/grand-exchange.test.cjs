// Run after `yarn build`: node --test tests/grand-exchange.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { ItemDefinition } = require('../dist/game/definition/ItemDefinition');
const {
  price,
  sellPrice,
  changePrice,
  collectionOutputId,
  fillDelayMs,
  remainingLimit,
  recordLimit,
  setMarketData,
  LIMITS_ATTRIBUTE,
  LIMIT_WINDOW_MS,
  OFFERS_ATTRIBUTE,
} = require('../plugins/interface/GrandExchange.plugin')._test;

const definitions = new Map();
const market = {};

function define(id, values = {}) {
  const definition = {
    id,
    unNote: () => id,
    isNoted: () => false,
    getName: () => `Item ${id}`,
    getGrandExchangeValue: () => 1,
    getGrandExchangeSellValue: () => 1,
    getNoteId: () => -1,
    ...values,
  };
  definitions.set(id, definition);
  return definition;
}

ItemDefinition.forId = (id) => definitions.get(id) ?? define(id);

const INVERTED = 1001;
define(INVERTED, { getGrandExchangeValue: () => 67, getGrandExchangeSellValue: () => 18 });
const NO_SELL_QUOTE = 1002;
define(NO_SELL_QUOTE, { getGrandExchangeValue: () => 42, getGrandExchangeSellValue: undefined });
const NOTEABLE = 1003;
const NOTE = 1004;
define(NOTEABLE, { getNoteId: () => NOTE });
define(NOTE, { getNoteId: () => NOTEABLE, isNoted: () => true });
const NO_NOTE = 1005;

test('buy offers pay the high price and sell offers receive the low price', () => {
  assert.equal(price(INVERTED), 67);
  assert.equal(sellPrice(INVERTED), 18);
  assert.ok(price(INVERTED) > sellPrice(INVERTED));
  assert.ok(price(INVERTED) - sellPrice(INVERTED) > 0);
  assert.equal(sellPrice(NO_SELL_QUOTE), 42);
});

test('collection menus collect the item or its note they name', () => {
  // A single noteable item: op 1 Collect-item, op 2 Collect-note.
  assert.equal(collectionOutputId(NOTEABLE, 1, 1), NOTEABLE);
  assert.equal(collectionOutputId(NOTEABLE, 1, 2), NOTE);
  // A noteable stack: op 1 Collect-notes, op 2 Collect-items.
  assert.equal(collectionOutputId(NOTEABLE, 5, 1), NOTE);
  assert.equal(collectionOutputId(NOTEABLE, 5, 2), NOTEABLE);
  // Bank always takes the base item, and Collect-all notes when it can.
  assert.equal(collectionOutputId(NOTEABLE, 1, 3), NOTEABLE);
  assert.equal(collectionOutputId(NOTEABLE, 1, 1, true), NOTE);
  // Items without a noted form are never converted.
  assert.equal(collectionOutputId(NO_NOTE, 1, 1), NO_NOTE);
  assert.equal(collectionOutputId(NO_NOTE, 1, 2), NO_NOTE);
});

test('price controls step by one, five percent and the guide', () => {
  const offer = { itemId: INVERTED, sell: true, price: 100 };
  assert.equal(changePrice(offer, 8), 99);
  assert.equal(changePrice(offer, 9), 101);
  assert.equal(changePrice(offer, 10), 95);
  assert.equal(changePrice(offer, 13), 105);
  assert.equal(changePrice(offer, 11), sellPrice(INVERTED));
  assert.equal(changePrice({ ...offer, sell: false }, 11), price(INVERTED));
  // Offers saved before adjustable prices fall back to the guide.
  assert.equal(changePrice({ itemId: INVERTED, sell: true }, 9), sellPrice(INVERTED) + 1);
});

test('price controls stay within one coin and the maximum', () => {
  assert.equal(changePrice({ itemId: INVERTED, price: 1 }, 8), 1);
  assert.equal(changePrice({ itemId: INVERTED, price: 1 }, 10), 1);
  assert.equal(changePrice({ itemId: INVERTED, price: 0x7ffffffe }, 9), 0x7fffffff);
  assert.equal(changePrice({ itemId: INVERTED, price: 0x7fffffff }, 13), 0x7fffffff);
});

const HIGH_VOLUME = 2001;
define(HIGH_VOLUME);
market[HIGH_VOLUME] = { volume: 20_000_000 };
const SLOW = 2002;
define(SLOW);
market[SLOW] = { volume: 900 };
const PRICED = 2006;
define(PRICED, { getGrandExchangeValue: () => 100, getGrandExchangeSellValue: () => 90 });
market[PRICED] = { volume: 1440 };
const ILLIQUID = 2003;
const BROKEN_VOLUME = 2004;
define(BROKEN_VOLUME);
market[BROKEN_VOLUME] = { volume: NaN };
const NEGATIVE_VOLUME = 2005;
define(NEGATIVE_VOLUME);
market[NEGATIVE_VOLUME] = { volume: -10 };
const half = () => 0.5;

test('fill delay follows volume and quantity', () => {
  assert.equal(fillDelayMs({ itemId: HIGH_VOLUME, quantity: 1 }, half), 5_000);
  assert.equal(fillDelayMs({ itemId: SLOW, quantity: 150 }, half), 10 * 60_000);
  const single = fillDelayMs({ itemId: SLOW, quantity: 1 }, half);
  assert.ok(single > 0 && single < 10 * 60_000);

  let previous = 0;
  for (const quantity of [1, 10, 100, 1_000, 100_000]) {
    const delay = fillDelayMs({ itemId: SLOW, quantity }, half);
    assert.ok(delay >= previous, `quantity ${quantity}: ${delay} < ${previous}`);
    previous = delay;
  }
});

test('crossing the guide fills fast, resting away from it waits', () => {
  const atGuide = fillDelayMs({ itemId: PRICED, quantity: 1, price: 100 }, half);
  const over = fillDelayMs({ itemId: PRICED, quantity: 1, price: 110 }, half);
  const under = fillDelayMs({ itemId: PRICED, quantity: 1, price: 90 }, half);
  assert.ok(over <= 5_000, `overpaying took ${over}ms`);
  assert.ok(under === 10 * 60_000, `resting buy took ${under}ms`);
  assert.ok(atGuide > 5_000 && atGuide < 60_000, `guide took ${atGuide}ms`);

  const sellUnder = fillDelayMs({ itemId: PRICED, sell: true, quantity: 1, price: 81 }, half);
  const sellAbove = fillDelayMs({ itemId: PRICED, sell: true, quantity: 1, price: 99 }, half);
  assert.ok(sellUnder <= 5_000, `undercutting sell took ${sellUnder}ms`);
  assert.ok(sellAbove === 10 * 60_000, `resting sell took ${sellAbove}ms`);
});

test('unknown, zero, broken and negative volume is illiquid', () => {
  for (const itemId of [ILLIQUID, BROKEN_VOLUME, NEGATIVE_VOLUME]) {
    for (const random of [() => 0, half, () => 1]) {
      const delay = fillDelayMs({ itemId, quantity: 100 }, random);
      assert.ok(delay >= 60_000 && delay <= 5 * 60_000, `${itemId}: ${delay}`);
    }
  }
});

const LIMITED = 3001;
define(LIMITED);
market[LIMITED] = { limit: 150 };
const UNLIMITED = 3002;
define(UNLIMITED);
market[UNLIMITED] = { limit: 0 };
const NO_LIMIT_GETTER = 3003;
define(NO_LIMIT_GETTER);

function player() {
  const attributes = new Map();
  return {
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
}

test('buy and sell limits reset after four hours', () => {
  const p = player();
  const start = 1_000_000;
  assert.equal(remainingLimit(p, LIMITED, start), 150);
  recordLimit(p, LIMITED, 100, start);
  assert.equal(remainingLimit(p, LIMITED, start), 50);
  recordLimit(p, LIMITED, 60, start + 1_000);
  assert.equal(remainingLimit(p, LIMITED, start + 1_000), 0);
  assert.equal(remainingLimit(p, LIMITED, start + LIMIT_WINDOW_MS - 1), 0);
  assert.equal(remainingLimit(p, LIMITED, start + LIMIT_WINDOW_MS), 150);
  recordLimit(p, LIMITED, 20, start + LIMIT_WINDOW_MS);
  assert.equal(remainingLimit(p, LIMITED, start + LIMIT_WINDOW_MS), 130);
});

test('an unlimited item never runs out', () => {
  const p = player();
  assert.equal(remainingLimit(p, UNLIMITED, 0), Infinity);
  assert.equal(remainingLimit(p, NO_LIMIT_GETTER, 0), Infinity);
  recordLimit(p, UNLIMITED, 1_000_000, 0);
  assert.equal(remainingLimit(p, UNLIMITED, 0), Infinity);
});

test('buying and selling share the same item limit', () => {
  const p = player();
  const now = 5_000_000;
  recordLimit(p, LIMITED, 100, now);
  assert.equal(remainingLimit(p, LIMITED, now), 50);
  recordLimit(p, LIMITED, 30, now + 1);
  assert.equal(remainingLimit(p, LIMITED, now + 2), 20);
});

test('register persists both attributes', () => {
  const persisted = new Map();
  const api = new Proxy({}, {
    get: (_, key) => key === 'persistAttribute'
      ? (attribute, value) => persisted.set(attribute, value)
      : () => {},
  });
  const plugin = require('../plugins/interface/GrandExchange.plugin');
  plugin.register(api);
  assert.deepEqual([...persisted.keys()], [OFFERS_ATTRIBUTE, LIMITS_ATTRIBUTE]);
  assert.deepEqual(persisted.get(OFFERS_ATTRIBUTE), {});
  assert.deepEqual(persisted.get(LIMITS_ATTRIBUTE), {});
});

setMarketData(market);
