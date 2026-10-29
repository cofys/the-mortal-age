// Run after `yarn build`: node --test tests/cooking.test.cjs
// Cooking against rsprox captures: the cook menu, its lines, the burnt items and the animations.
const assert = require("node:assert/strict");
const { before, test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { PluginManager } = require("../dist/plugins/PluginManager");
const core = PluginManager.getCoreApi();
const { ItemIds } = require("../dist/util/IdEnums");

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const Cooking = require("../plugins/skills/Cooking.plugin");

before(() => CachePipeline.initialize());

const noop = () => {};
const hooks = { object: {}, itemOnObject: [], custom: {} };
Cooking.register(new Proxy({
  core,
  getTaskManager: () => ({ submit: noop }),
  emitCustomEvent: (name, request) => { if (name === "quest:is-complete") request.complete = true; },
  onObjectInteraction: (name, actions) => { hooks.object[name] = actions; },
  onItemOnObject: (handler, filter) => hooks.itemOnObject.push({ handler, filter }),
  onCustomEvent: (name, handler) => { hooks.custom[name] = handler; },
}, { get: (target, key) => target[key] ?? noop }));

function player(cooking, carried) {
  const slots = [];
  for (const [id, amount] of carried) for (let i = 0; i < amount; i++) slots.push({ getId: () => id });
  const sent = { spam: [], varbits: new Map(), menu: null, statements: [] };
  const attributes = new Map();
  const packet = new Proxy({
    sendCreationMenu: (menu) => { sent.menu = menu; return packet; },
    sendTypedMessage: (type, text) => { sent.spam.push([type, text]); return packet; },
    sendVarbit: (id, value) => { sent.varbits.set(id, value); return packet; },
  }, { get: (target, key) => target[key] ?? (() => packet) });
  const inventory = {
    getItems: () => slots,
    getAmount: (id) => slots.filter((item) => item.getId() === id).length,
    contains: (id) => slots.some((item) => item.getId() === id),
  };
  return {
    sent,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getInventory: () => inventory,
    getPacketSender: () => packet,
    getEquipment: () => ({ getItems: () => [] }),
    getSkillManager: () => ({ getCurrentLevel: () => cooking }),
    getDialogueManager: () => ({ startDialogues: (chain) => sent.statements.push(chain) }),
    performAnimation: noop,
  };
}

function cooker(name) {
  return {
    getId: () => 1,
    getDefinition: () => ({ getName: () => name, getInteractions: () => name === "Fire" ? [] : ["Cook"] }),
    getLocation: () => new core.Location(3222, 3218, 0),
    getPrivateArea: () => null,
  };
}

function statementText(chain) {
  return JSON.stringify(chain, (key, value) => value instanceof Map ? [...value.values()] : value).match(/You [^"]+/)?.[0];
}

test("the captured success and burn lines", () => {
  const line = (raw) => Cooking._test.successMessage(Cooking.COOKABLE_BY_RAW.get(raw));
  assert.equal(line(ItemIds.RAW_SHARK), "You successfully cook a shark.");
  assert.equal(line(ItemIds.RAW_ANGLERFISH), "You successfully cook an anglerfish.");
  assert.equal(line(ItemIds.RAW_SHRIMPS), "You successfully cook some shrimps.");
  assert.equal(line(ItemIds.RAW_BASS), "You cook a bass.");
  assert.equal(line(ItemIds.RAW_TUNA), "You manage to cook a tuna.");
  assert.equal(line(ItemIds.RAW_RABBIT), "You cook the rabbit.");
  assert.equal(line(ItemIds.BREAD_DOUGH), "You successfully bake some bread.");
  assert.equal(Cooking._test.burnMessage(Cooking.COOKABLE_BY_RAW.get(ItemIds.RAW_HERRING)), "You accidentally burn the herring.");
  assert.equal(Cooking._test.burnMessage(Cooking.COOKABLE_BY_RAW.get(ItemIds.RAW_KARAMBWAN)), "You accidentally burn the karambwan.");
});

test("burnt items are the captured and Wiki ones", () => {
  const burnt = (raw) => Cooking.COOKABLE_BY_RAW.get(raw).burnt;
  const id = (name) => core.CacheDefinitions.getObjId(name);
  assert.equal(burnt(ItemIds.RAW_HERRING), id("burntfish3"));
  assert.equal(burnt(ItemIds.RAW_MACKEREL), id("burntfish3"));
  assert.equal(burnt(ItemIds.RAW_BASS), id("burntfish4"));
  assert.equal(burnt(ItemIds.RAW_TUNA), id("burntfish4"));
  for (const raw of [ItemIds.RAW_TROUT, ItemIds.RAW_COD, ItemIds.RAW_PIKE, ItemIds.RAW_SALMON]) assert.equal(burnt(raw), id("burntfish2"));
  assert.equal(burnt(ItemIds.RAW_SARDINE), id("burntfish5"));
  assert.equal(burnt(ItemIds.RAW_ANCHOVIES), id("burntfish1"));
  assert.equal(burnt(ItemIds.RAW_RABBIT), id("burnt_meat"));
});

test("fires and the house's stoves play human_firecooking, other ranges and ovens human_cooking", () => {
  const seq = (name) => Cooking._test.cookAnimationFor(name).getId();
  for (const name of ["Fire", "Firepit with hook", "Small oven"]) assert.equal(seq(name), core.CacheDefinitions.getSeqId("human_firecooking"), name);
  for (const name of ["Range", "Cooking range", "Oven"]) assert.equal(seq(name), core.CacheDefinitions.getSeqId("human_cooking"), name);
});

test("one raw food opens the how-many menu on the raw item; several open the what menu on the cooked ones", () => {
  const one = player(50, [[ItemIds.RAW_TROUT, 3]]);
  hooks.object.Range.Cook({ player: one, object: cooker("Range") });
  assert.equal(one.sent.menu.getTitle(), "How many would you like to cook?");
  assert.deepEqual(one.sent.menu.getItems(), [ItemIds.RAW_TROUT]);
  assert.deepEqual(one.sent.menu.getOptions(), { mode: 6, maxAmount: 3, lastAmount: 3 });

  const many = player(50, [[ItemIds.RAW_SHRIMPS, 2], [ItemIds.RAW_TROUT, 5]]);
  hooks.object.Oven.Cook({ player: many, object: cooker("Oven") });
  assert.equal(many.sent.menu.getTitle(), "What would you like to cook?");
  assert.deepEqual(many.sent.menu.getItems(), [ItemIds.SHRIMPS, ItemIds.TROUT]);
  assert.equal(many.sent.menu.getOptions().maxAmount, 5);
});

test("the what menu shows the karambwan the player will get: poison until Tinsay's training", () => {
  const untaught = player(50, [[ItemIds.RAW_KARAMBWAN, 2], [ItemIds.RAW_TROUT, 2]]);
  hooks.object.Range.Cook({ player: untaught, object: cooker("Range") });
  assert.deepEqual(untaught.sent.menu.getItems(), [ItemIds.POISON_KARAMBWAN, ItemIds.TROUT]);
  untaught.sent.menu.execute(ItemIds.POISON_KARAMBWAN, 2);
  assert.equal(Cooking.isCookingActive(untaught), true, "the poison karambwan entry starts the raw karambwan recipe");

  const taught = player(50, [[ItemIds.RAW_KARAMBWAN, 2], [ItemIds.RAW_TROUT, 2]]);
  taught.setAttribute("quest.tai_bwo_wannai_trio.tinsay", 8);
  hooks.object.Range.Cook({ player: taught, object: cooker("Range") });
  assert.deepEqual(taught.sent.menu.getItems(), [ItemIds.COOKED_KARAMBWAN, ItemIds.TROUT]);
});

test("a single raw item cooks without a menu", () => {
  const p = player(50, [[ItemIds.RAW_TROUT, 1]]);
  const event = { player: p, object: cooker("Fire"), itemId: ItemIds.RAW_TROUT, handled: false };
  hooks.itemOnObject.find(({ filter }) => !filter.fallback).handler(event);
  assert.equal(event.handled, true);
  assert.equal(p.sent.menu, null);
  assert.equal(Cooking.isCookingActive(p), true);
});

test("refusals are message boxes", () => {
  const low = player(50, [[ItemIds.RAW_SHARK, 2]]);
  hooks.itemOnObject.find(({ filter }) => !filter.fallback).handler({ player: low, object: cooker("Fire"), itemId: ItemIds.RAW_SHARK });
  assert.equal(statementText(low.sent.statements[0]), "You need a Cooking level of 80 to cook a shark.");

  const empty = player(50, []);
  hooks.object.Range.Cook({ player: empty, object: cooker("Range") });
  assert.equal(statementText(empty.sent.statements[0]), "You haven't got anything to cook.");

  const bucket = player(50, [[ItemIds.BUCKET, 1]]);
  const refuse = hooks.itemOnObject.find(({ filter }) => filter.fallback);
  const event = { player: bucket, object: cooker("Range"), itemId: ItemIds.BUCKET, handled: false };
  refuse.handler(event);
  assert.equal(event.handled, true);
  assert.equal(statementText(bucket.sent.statements[0]), "You can't cook that.");
});

test("the Gauntlet's cooks move cooking_success_count", () => {
  const p = player(50, []);
  const varbit = core.CacheDefinitions.getVarbitId("cooking_success_count");
  hooks.custom["cooking:count"]({ player: p, burnt: false });
  hooks.custom["cooking:count"]({ player: p, burnt: false });
  assert.equal(p.sent.varbits.get(varbit), 2);
  hooks.custom["cooking:count"]({ player: p, burnt: true });
  assert.equal(p.sent.varbits.get(varbit), 0);
});
