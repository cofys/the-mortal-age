// Finite shop stock: no NPC shop may carry infinite (2^31) stock.
// Run with: node --test tests/shops-finite-stock.test.cjs
// (pure JSON validation — no build required)
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const INFINITE = 2000000000;
const MAX_SANE_STOCK = 100000;

function load(name) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/definitions', name), 'utf8')
  );
}

const shops = load('shops.json');
const customShops = load('custom-shops.json');

test('no infinite originalStock amounts in shops.json', () => {
  const bad = [];
  for (const shop of shops) {
    for (const e of shop.originalStock || []) {
      if (e.amount === INFINITE) bad.push(`${shop.name}: item ${e.id}`);
      assert.ok(e.amount > 0, `${shop.name}: item ${e.id} has non-positive stock`);
      assert.ok(
        e.amount < MAX_SANE_STOCK,
        `${shop.name}: item ${e.id} stock ${e.amount} exceeds sane max`
      );
    }
  }
  assert.deepEqual(bad, [], `infinite stock entries remain: ${bad.slice(0, 5).join(', ')}`);
});

test('no infinite stockAmount or originalStock in custom-shops.json', () => {
  const bad = [];
  for (const shop of customShops) {
    if (shop.stockAmount === INFINITE) bad.push(`${shop.name}: stockAmount`);
    if (shop.stockAmount != null) {
      assert.ok(shop.stockAmount > 0, `${shop.name}: non-positive stockAmount`);
      assert.ok(
        shop.stockAmount < MAX_SANE_STOCK,
        `${shop.name}: stockAmount ${shop.stockAmount} exceeds sane max`
      );
    }
    for (const e of shop.originalStock || []) {
      if (e.amount === INFINITE) bad.push(`${shop.name}: item ${e.id}`);
    }
  }
  assert.deepEqual(bad, [], `infinite stock entries remain: ${bad.slice(0, 5).join(', ')}`);
});

test('converted entries carry explicit restockTicks', () => {
  // Every originalStock entry that was converted from infinite must have a
  // restockTicks so restock speed is tuned, not the 4-tick global default.
  let checked = 0;
  for (const shop of shops) {
    for (const e of shop.originalStock || []) {
      if (e.restockTicks != null) {
        assert.ok(
          Number.isInteger(e.restockTicks) && e.restockTicks > 0,
          `${shop.name}: item ${e.id} has invalid restockTicks ${e.restockTicks}`
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 600, `expected 600+ tuned entries, found ${checked}`);
});

test('custom shops declare defaultRestockTicks', () => {
  // stockAmount entries inherit restockTicks:null -> shop default -> global 4t.
  // Every custom shop must declare its own default so rares don't restock
  // like bread.
  for (const shop of customShops) {
    if (shop.stockAmount != null) {
      const ticks = shop.defaultRestockTicks ?? shop.restockTicks;
      assert.ok(
        Number.isInteger(ticks) && ticks > 0,
        `${shop.name} (id ${shop.id}): missing defaultRestockTicks`
      );
    }
  }
});

test('rarity tiers are sane: expensive items have shallow stock', () => {
  // Spot-check the value-tiered conversion: a cheap basic vs an expensive rare.
  const general = shops.find((s) => s.id === 0);
  assert.ok(general, 'General Store exists');
  for (const e of general.originalStock) {
    // basics (tinderbox/axe/pickaxe/knife/hammer/chisel, all value <= 100;
    // stake has value 0 -> unknown tier)
    assert.ok(e.amount <= 1000, `General Store item ${e.id}: stock ${e.amount} too deep for a basic`);
    assert.ok(e.amount >= 50, `General Store item ${e.id}: stock ${e.amount} too shallow for a basic`);
  }
  // PK Weapon Shop must stay scarce (prestige rewards, blood money)
  const pk = customShops.find((s) => s.id === 13);
  assert.ok(pk, 'PK Weapon Shop exists');
  assert.ok(pk.stockAmount <= 25, `PK Weapon Shop stockAmount ${pk.stockAmount} too deep`);
  assert.ok(pk.defaultRestockTicks >= 300, `PK Weapon Shop restocks too fast`);
  // Rune Shop must stay deep (bulk consumable)
  const runes = customShops.find((s) => s.id === 1);
  assert.ok(runes, 'Rune Shop exists');
  assert.ok(runes.stockAmount >= 1000, `Rune Shop stockAmount ${runes.stockAmount} too shallow`);
});
