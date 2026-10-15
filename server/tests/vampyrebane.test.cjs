// Run after `yarn build`: node --test tests/vampyrebane.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const registerVampyrebane = require("../plugins/combat/effects/Vampyrebane.EquipmentEffects");

const NAMES = new Map([
  [22398, "Ivandis flail"],
  [24697, "Blisterwood sickle"],
  [33713, "Blisterwood sickle (e)"],
  [24699, "Blisterwood flail"],
  [33718, "Hallowed flail"],
  [33716, "Blisterwood stake"],
  [33722, "Sunspear"],
]);
ItemDefinition.forId = (id) => ({ getName: () => NAMES.get(id) ?? "" });

function target(attribute) {
  return {
    isNpc: () => true,
    getAsNpc: () => ({
      getCurrentDefinition: () => ({ hasAttribute: (value) => value === attribute }),
    }),
  };
}

function createPlayer(weaponId, attribute = "vampyre") {
  const items = new Array(14).fill(null).map(() => ({ getId: () => -1 }));
  items[Equipment.WEAPON_SLOT] = { getId: () => weaponId };
  return {
    isPlayer: () => true,
    getAsPlayer() { return this; },
    getEquipment: () => ({ getItems: () => items }),
    getCombat: () => ({ getTarget: () => target(attribute) }),
  };
}

function modifiers() {
  const result = {};
  const api = {
    registerMeleeHitModifier: (fn) => { result.meleeDamage = fn; },
    registerMeleeAttackAccuracyModifier: (fn) => { result.meleeAccuracy = fn; },
    registerRangedHitModifier: (fn) => { result.rangedDamage = fn; },
    registerRangedAttackAccuracyModifier: (fn) => { result.rangedAccuracy = fn; },
  };
  registerVampyrebane(api);
  return result;
}

test("vampyrebane weapons apply their Wiki accuracy and damage bonuses only to vampyres", () => {
  const effect = modifiers();
  const cases = [
    [22398, 20, 0],
    [24697, 15, 5],
    [33713, 15, 5],
    [24699, 25, 5],
    [33718, 25, 25],
    [33722, 50, 25],
  ];
  for (const [id, damagePercent, accuracyPercent] of cases) {
    const player = createPlayer(id);
    assert.equal(effect.meleeDamage(player, 101), Math.floor(101 * (100 + damagePercent) / 100), `melee damage for ${NAMES.get(id)}`);
    assert.equal(effect.meleeAccuracy(player, 101), Math.floor(101 * (100 + accuracyPercent) / 100), `melee accuracy for ${NAMES.get(id)}`);
  }

  const stake = createPlayer(33716);
  assert.equal(effect.rangedDamage(stake, 101), 126);
  assert.equal(effect.rangedAccuracy(stake, 101), 126);
  assert.equal(effect.meleeDamage(stake, 101), 101, "stakes boost ranged attacks only");

  const human = createPlayer(33718, "undead");
  assert.equal(effect.meleeDamage(human, 101), 101, "other attributes do not receive the bonus");
  assert.equal(effect.meleeAccuracy(human, 101), 101);
  assert.equal(effect.rangedDamage(createPlayer(33716, ""), 101), 101);
  assert.equal(effect.meleeDamage({ isPlayer: () => false }, 101), 101);
});
