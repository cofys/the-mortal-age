"use strict";

/**
 * item-wear.test.js — plain-node tests for the wear/repair/crafting-quality
 * system. No dist build needed: lib/item-wear.js is pure, and the plugins
 * expose their internals via `_test`.
 *
 * Verifies:
 *  - durability decreases with use (degrade tick)
 *  - repair restores to full (setDurability / repairCost)
 *  - broken items are unusable (onCanEquip blocks, bonuses zeroed)
 *  - quality tiers affect stats (+3% / +6%, attack+defence only)
 *  - pre-existing items default to pristine (no meta = full durability)
 *  - bespoke degradation systems (barrows etc.) are never double-degraded
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");

const wear = require("./item-wear");
const ItemWear = require("../ItemWear.plugin");
const CraftingQuality = require("../CraftingQuality.plugin");
const { before } = require("node:test");

// Wire the plugin's module-level `core` so repairOnAnvil can read
// Skill.SMITHING and ItemIds.HAMMER, as attach() does in production.
before(() => {
  const noop = () => {};
  ItemWear.attach({
    core: {
      Skill: { SMITHING: 13 },
      ItemIds: { HAMMER: 2347 },
      Equipment: { WEAPON_SLOT: 3 },
    },
    getBonusManager: () => null,
    onCombatHitResolved: noop,
    onCanEquip: noop,
    onItemOnObject: noop,
    registerBonusProvider: noop,
  });
});

function mockItem({
  id = 1,
  slot = 3,
  name = "Rune sword",
  highAlch = 10000,
  bonuses = [],
  meta = {},
} = {}) {
  const store = { ...meta };
  return {
    getId: () => id,
    getMetaValue: (k) => store[k],
    setMetaValue: (k, v) => {
      if (v === undefined) delete store[k];
      else store[k] = v;
    },
    getDefinition: () => ({
      getName: () => name,
      getHighAlchValue: () => highAlch,
      getBonuses: () => bonuses,
      getEquipmentType: () => ({ getSlot: () => slot }),
    }),
    _meta: store,
  };
}

function mockPlayer() {
  const messages = [];
  return {
    messages,
    sendMessage: (m) => messages.push(m),
    getInventory: () => ({ refreshItems() {} }),
    getEquipment: () => ({ refreshItems() {}, get: () => null }),
  };
}

function noSkipRng() {
  return 0.99; // above every QUALITY_WEAR_SKIP chance
}

test("fresh items default to full durability (pre-existing items are pristine)", () => {
  const sword = mockItem();
  assert.equal(wear.getDurability(sword), wear.MAX_DURABILITY);
  assert.equal(wear.isBroken(sword), false);
  assert.equal(wear.WEAR_META_KEY in sword._meta, false);
});

test("durability decreases with use via degrade()", () => {
  ItemWear._test.setRng(noSkipRng);
  const sword = mockItem();
  const player = mockPlayer();
  const broke = ItemWear._test.degrade(player, sword);
  assert.equal(broke, false);
  assert.equal(wear.getDurability(sword), wear.MAX_DURABILITY - 1);
});

test("degrade warns at 25% and 10% thresholds, then breaks at 0", () => {
  ItemWear._test.setRng(noSkipRng);
  const sword = mockItem();
  const player = mockPlayer();
  wear.setDurability(sword, 251);
  ItemWear._test.degrade(player, sword);
  assert.match(player.messages[player.messages.length - 1], /wearing down.*25%/);

  wear.setDurability(sword, 101);
  ItemWear._test.degrade(player, sword);
  assert.match(player.messages[player.messages.length - 1], /wearing down.*10%/);

  wear.setDurability(sword, 1);
  const broke = ItemWear._test.degrade(player, sword);
  assert.equal(broke, true);
  assert.equal(wear.isBroken(sword), true);
  assert.match(player.messages[player.messages.length - 1], /has broken/);
});

test("fine/superior gear sometimes skips wear ticks", () => {
  const fine = mockItem();
  wear.setQuality(fine, 1);
  const player = mockPlayer();
  // rng below the 0.25 skip chance: no wear happens
  ItemWear._test.setRng(() => 0.1);
  ItemWear._test.degrade(player, fine);
  assert.equal(wear.getDurability(fine), wear.MAX_DURABILITY);
  // rng above it: wear happens
  ItemWear._test.setRng(noSkipRng);
  ItemWear._test.degrade(player, fine);
  assert.equal(wear.getDurability(fine), wear.MAX_DURABILITY - 1);
});

test("repair restores durability to full and clears the meta key", () => {
  const sword = mockItem();
  wear.setDurability(sword, 123);
  assert.equal(wear.repairCost(sword) > 0, true);
  wear.setDurability(sword, wear.MAX_DURABILITY);
  assert.equal(wear.getDurability(sword), wear.MAX_DURABILITY);
  assert.equal(wear.WEAR_META_KEY in sword._meta, false);
  assert.equal(wear.repairCost(sword), 0);
});

test("repair cost scales with item value", () => {
  ItemWear._test.setRng(noSkipRng);
  const cheap = mockItem({ highAlch: 100 });
  const pricey = mockItem({ highAlch: 1000000 });
  wear.setDurability(cheap, 500);
  wear.setDurability(pricey, 500);
  const cheapCost = wear.repairCost(cheap);
  const priceyCost = wear.repairCost(pricey);
  assert.equal(cheapCost > 0, true);
  assert.equal(priceyCost > cheapCost, true);
});

test("broken items cannot be equipped", () => {
  const sword = mockItem();
  wear.setDurability(sword, 0);
  const player = mockPlayer();
  const event = { item: sword, player, allow: null };
  ItemWear._test.onCanEquip(event);
  assert.equal(event.allow, false);
  assert.match(player.messages[0], /broken/);
});

test("broken items grant no combat bonuses", () => {
  const sword = mockItem({ bonuses: [10, 0, 0, 0, 0, 5, 0, 0, 0, 0] });
  wear.setDurability(sword, 0);
  wear.setQuality(sword, 2); // superior: must not leak +6% either
  const bonuses = [10, 0, 0, 0, 0, 5, 0, 0, 0, 0];
  ItemWear._test.applyBrokenPenalty({
    player: { getEquipment: () => ({ getItems: () => [sword] }) },
    bonuses,
  });
  assert.deepEqual(bonuses.slice(0, 10), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("quality tiers uplift attack/defence bonuses (+3% / +6%)", () => {
  const base = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 50, 50];
  const fine = mockItem({ bonuses: base });
  wear.setQuality(fine, 1);
  const fineBonuses = [...base];
  CraftingQuality._test.applyQualityBonus({
    player: { getEquipment: () => ({ getItems: () => [fine] }) },
    bonuses: fineBonuses,
  });
  assert.deepEqual(fineBonuses.slice(0, 10), new Array(10).fill(103));
  // strength/prayer untouched
  assert.deepEqual(fineBonuses.slice(10), [50, 50]);

  const sup = mockItem({ bonuses: base });
  wear.setQuality(sup, 2);
  const supBonuses = [...base];
  CraftingQuality._test.applyQualityBonus({
    player: { getEquipment: () => ({ getItems: () => [sup] }) },
    bonuses: supBonuses,
  });
  assert.deepEqual(supBonuses.slice(0, 10), new Array(10).fill(106));
});

test("quality bonus does not apply to broken items", () => {
  const fine = mockItem({ bonuses: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  wear.setQuality(fine, 1);
  wear.setDurability(fine, 0);
  const bonuses = [100, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  CraftingQuality._test.applyQualityBonus({
    player: { getEquipment: () => ({ getItems: () => [fine] }) },
    bonuses,
  });
  assert.equal(bonuses[0], 100);
});

test("bespoke degradation systems are never double-degraded", () => {
  const dharoks = mockItem({ name: "Dharok's greataxe", meta: { barrows: 75 } });
  assert.equal(wear.isWearable(dharoks), false);
  assert.equal(wear.isBroken(dharoks), false);
});

test("non-wear slots (cape, amulet, ring, ammo) never wear", () => {
  for (const slot of [1, 2, 12, 13]) {
    assert.equal(wear.isWearable(mockItem({ slot })), false, `slot ${slot}`);
  }
  for (const slot of [0, 3, 4, 5, 7, 9, 10]) {
    assert.equal(wear.isWearable(mockItem({ slot })), true, `slot ${slot}`);
  }
});

test("rollQuality rewards high margins, never below requirement", () => {
  // margin < 0: always normal
  for (let i = 0; i < 20; i++) assert.equal(wear.rollQuality(-5, () => 0), 0);
  // margin >= 20, roll 0.1: superior
  assert.equal(wear.rollQuality(25, () => 0.1), 2);
  // margin >= 20, roll 0.3: fine
  assert.equal(wear.rollQuality(25, () => 0.3), 1);
  // margin >= 20, roll 0.9: normal
  assert.equal(wear.rollQuality(25, () => 0.9), 0);
  // margin 0..9: only fine possible, at 10%
  assert.equal(wear.rollQuality(5, () => 0.05), 1);
  assert.equal(wear.rollQuality(5, () => 0.5), 0);
});

test("smithingLevelFor maps metals to sensible repair levels", () => {
  assert.equal(wear.smithingLevelFor(mockItem({ name: "Rune scimitar" })), 40);
  assert.equal(wear.smithingLevelFor(mockItem({ name: "Dragon dagger" })), 60);
  assert.equal(wear.smithingLevelFor(mockItem({ name: "Bronze sword" })), 1);
  assert.equal(wear.smithingLevelFor(mockItem({ name: "Maple longbow" })), 1);
});

test("repairOnAnvil: free self-repair with hammer and level", () => {
  const sword = mockItem({ name: "Steel sword" });
  wear.setDurability(sword, 400);
  const messages = [];
  const player = {
    sendMessage: (m) => messages.push(m),
    getInventory: () => ({
      getItems: () => [sword],
      contains: () => true, // has hammer
      refreshItems() {},
    }),
    getEquipment: () => ({ refreshItems() {} }),
    getSkillManager: () => ({ getCurrentLevel: () => 99 }),
  };
  const event = {
    player,
    itemId: 1,
    object: { getDefinition: () => ({ getName: () => "Anvil" }) },
    handled: false,
  };
  ItemWear._test.repairOnAnvil(event);
  assert.equal(event.handled, true);
  assert.equal(wear.getDurability(sword), wear.MAX_DURABILITY);
  assert.match(messages[messages.length - 1], /pristine/);
});

test("repairOnAnvil: bars fall through to Smithing untouched", () => {
  const bar = mockItem({ id: 2351, slot: -1, name: "Steel bar" });
  const event = {
    player: mockPlayer(),
    itemId: 2351,
    object: { getDefinition: () => ({ getName: () => "Anvil" }) },
    handled: false,
  };
  // inventory holds only the bar; findDamagedWearable must not match it
  event.player.getInventory = () => ({ getItems: () => [bar] });
  ItemWear._test.repairOnAnvil(event);
  assert.equal(event.handled, false);
});
