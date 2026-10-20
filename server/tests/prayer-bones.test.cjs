// Run after `yarn build`: node --test tests/prayer-bones.test.cjs
// Prayer's bone data, its restore (Catacombs of Kourend, dragonbone necklace, never stacked), the
// bonecrusher's crushing and charges (docs/prayer-bones.md).
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before, beforeEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { Skill } = require("../dist/game/model/Skill");
const { Location } = require("../dist/game/model/Location");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemIdentifiers: Items } = require("../dist/util/ItemIdentifiers");
const { ObjectIdentifiers: Objects } = require("../dist/util/ObjectIdentifiers");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");

const DATA = require("../plugins/skills/data/bones.json");

const handlers = new Map();
const api = {
  core: { Skill, Location, Equipment, ItemIdentifiers: Items, ObjectIdentifiers: Objects, CacheDefinitions },
  emitCustomEvent: (name, payload) => (handlers.get(name) ?? []).forEach((handler) => handler(payload)),
  onCustomEvent: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  persistAttribute() {},
  onItemFirstAction() {},
  onItemAction() {},
  onItemOnItem() {},
  onObjectInteraction() {},
};

let diaryElite = false;

before(async () => {
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/skills/Prayer.plugin").register(api);
  require("../plugins/items/DragonboneNecklace.plugin").register(api);
  require("../plugins/items/Bonecrusher.plugin").register(api);
  require("../plugins/areas/CatacombsOfKourend.plugin").register(api);
  api.onCustomEvent("diary:is-complete", (request) => {
    if (request.diary === "morytania" && request.tier === "elite") request.complete = diaryElite;
  });
});

beforeEach(() => {
  diaryElite = false;
});

function player({ at = [3222, 3218], prayer = 50, maxPrayer = 70, amulet = null, inventory = {} } = {}) {
  const attributes = new Map();
  const xp = new Map();
  const levels = { current: prayer, max: maxPrayer };
  const items = { ...inventory };
  const messages = [];
  const worn = [];
  worn[Equipment.AMULET_SLOT] = amulet ? { getId: () => amulet } : null;
  return {
    messages, xp, levels,
    getLocation: () => new Location(at[0], at[1], 0),
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (text) => messages.push(text),
    getPacketSender: () => ({ sendSound() {} }),
    getEquipment: () => ({ get: (slot) => worn[slot] }),
    getInventory: () => ({
      contains: (id) => (items[id] ?? 0) > 0,
      getAmount: (id) => items[id] ?? 0,
      getFreeSlots: () => 10,
      adds: (id, amount) => { items[id] = (items[id] ?? 0) + amount; },
      deleteNumber: (id, amount) => { items[id] -= amount; },
    }),
    getSkillManager: () => ({
      addExperiences: (skill, amount) => xp.set(skill, (xp.get(skill) ?? 0) + amount),
      getMaxLevel: () => levels.max,
      getCurrentLevel: () => levels.current,
      increaseCurrentLevel: (skill, amount, max) => { levels.current = Math.min(levels.current + amount, max); },
    }),
  };
}

const bury = (who, itemId, extra = {}) => {
  const request = { player: who, itemId, handled: false, ...extra };
  api.emitCustomEvent("prayer:bury", request);
  return request.handled;
};

test("every bone and bonemeal in the data is a real obj, and every bone's bonemeal has a worship row", () => {
  const bonemeal = new Set(DATA.bonemeal.map((row) => row.obj));
  for (const row of [...DATA.bones, ...DATA.bonemeal]) {
    assert.ok(Number.isInteger(CacheDefinitions.getObjId(row.obj)), row.obj);
  }
  for (const row of DATA.bones) assert.ok(bonemeal.has(row.bonemeal), `${row.obj} -> ${row.bonemeal}`);
});

test("worship gives four times the burying experience, as the Wiki's tables do", () => {
  const worship = new Map(DATA.bonemeal.map((row) => [row.obj, row.xp]));
  for (const bone of ["big_bones", "dragon_bones", "dagannoth_king_bones", "dragon_bones_superior"]) {
    const row = DATA.bones.find((entry) => entry.obj === bone);
    assert.equal(worship.get(row.bonemeal), row.xp * 4, bone);
  }
});

test("burying rounds a bone's tenths up, and restores nothing outside the Catacombs without the necklace", () => {
  const who = player();
  assert.equal(bury(who, Items.BONES), true);
  assert.equal(who.xp.get(Skill.PRAYER), 5);
  assert.equal(who.levels.current, 50);
  assert.equal(bury(who, Items.COINS), false);
});

test("the Catacombs give back the bone's restore, and the necklace there doesn't add to it", () => {
  const inside = player({ at: [1666, 10050], amulet: Items.DRAGONBONE_NECKLACE });
  bury(inside, Items.DRAGON_BONES);
  assert.equal(inside.levels.current, 54);
  const worn = player({ amulet: Items.DRAGONBONE_NECKLACE });
  bury(worn, Items.BIG_BONES);
  assert.equal(worn.levels.current, 52);
});

test("a restore never lifts Prayer above its level", () => {
  const who = player({ at: [1666, 10050], prayer: 69 });
  bury(who, Items.DRAGON_BONES);
  assert.equal(who.levels.current, 70);
});

function kill(who, drops) {
  const event = { player: who, drops, handled: false };
  api.emitCustomEvent("npc-drops:generated", event);
  return event.drops;
}

test("the bonecrusher crushes a kill's bones for half their experience, one charge each", () => {
  const who = player({ inventory: { [Items.BONECRUSHER]: 1 } });
  who.setAttribute("bonecrusher:charges", 10);
  const left = kill(who, [{ itemId: Items.BIG_BONES, amount: 2 }, { itemId: Items.COINS, amount: 5 }]);
  assert.deepEqual(left.map((drop) => drop.itemId), [Items.COINS]);
  assert.equal(who.xp.get(Skill.PRAYER), 16);
  assert.equal(who.getAttribute("bonecrusher:charges"), 8);
});

test("with the elite Morytania diary it gives all the experience", () => {
  diaryElite = true;
  const who = player({ inventory: { [Items.BONECRUSHER]: 1 } });
  who.setAttribute("bonecrusher:charges", 10);
  kill(who, [{ itemId: Items.DRAGON_BONES, amount: 1 }]);
  assert.equal(who.xp.get(Skill.PRAYER), 72);
});

test("noted bones, tertiary long bones, an empty or inactive crusher or one in the bank leave the bones", () => {
  const who = player({ inventory: { [Items.BONECRUSHER]: 1 } });
  who.setAttribute("bonecrusher:charges", 10);
  const longBone = CacheDefinitions.getObjId("dorgesh_construction_bone");
  assert.equal(kill(who, [{ itemId: Items.BONES, amount: 1, noted: true }, { itemId: longBone, amount: 1 }]).length, 2);
  who.setAttribute("bonecrusher:inactive", 1);
  assert.equal(kill(who, [{ itemId: Items.BONES, amount: 1 }]).length, 1);
  const none = player({ inventory: { [Items.BONECRUSHER]: 1 } });
  assert.equal(kill(none, [{ itemId: Items.BONES, amount: 1 }]).length, 1);
  const banked = player();
  banked.setAttribute("bonecrusher:charges", 10);
  assert.equal(kill(banked, [{ itemId: Items.BONES, amount: 1 }]).length, 1);
});

test("every hundredth charge says how many are left, and a crush in the Catacombs restores Prayer", () => {
  const who = player({ at: [1666, 10050], inventory: { [Items.BONECRUSHER]: 1 } });
  who.setAttribute("bonecrusher:charges", 5701);
  kill(who, [{ itemId: Items.BONES, amount: 2 }]);
  assert.deepEqual(who.messages, ["Your bonecrusher has 5,700 charges left."]);
  assert.equal(who.levels.current, 52);
});
