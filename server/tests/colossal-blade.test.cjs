// Run after `yarn build`: node --test tests/colossal-blade.test.cjs
//
// Colossal blade (Wiki): "MaxHit + [2 × min(MonsterSize,5)]" against the monster it hits.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { ItemIdentifiers: I } = require("../dist/util/ItemIdentifiers");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { meleeDamage } = require("../plugins/combat/effects/ColossalBlade.EquipmentEffects")._test;

before(async () => {
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
});

function attacker(weaponId, target) {
  const items = [];
  items[Equipment.WEAPON_SLOT] = { getId: () => weaponId };
  const player = {
    isPlayer: () => true,
    getAsPlayer: () => player,
    getEquipment: () => ({ getItems: () => items }),
    getCombat: () => ({ getTarget: () => target }),
  };
  return player;
}

const npc = (size) => {
  const target = { isNpc: () => true, getSize: () => size };
  target.getAsNpc = () => target;
  return target;
};

test("the blade adds twice the monster's size, at most 10", () => {
  assert.equal(meleeDamage(attacker(I.COLOSSAL_BLADE, npc(1)), 40), 42);
  assert.equal(meleeDamage(attacker(I.COLOSSAL_BLADE, npc(3)), 40), 46);
  assert.equal(meleeDamage(attacker(I.COLOSSAL_BLADE, npc(5)), 40), 50);
  assert.equal(meleeDamage(attacker(I.COLOSSAL_BLADE, npc(7)), 40), 50);
});

test("no bonus with another weapon, against a player, or without a target", () => {
  assert.equal(meleeDamage(attacker(I.RUNE_2H_SWORD, npc(5)), 40), 40);
  assert.equal(meleeDamage(attacker(I.COLOSSAL_BLADE, { isNpc: () => false }), 40), 40);
  assert.equal(meleeDamage(attacker(I.COLOSSAL_BLADE, null), 40), 40);
});
